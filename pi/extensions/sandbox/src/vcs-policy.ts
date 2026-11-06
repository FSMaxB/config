import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { exact, glob, tree, type PathSelector } from "../../lib/path-permission-rules.ts";

type Platform = "darwin" | "linux";

// What git and jj write during normal operation, relative to the directory each spec describes.
interface DirectorySpec {
  // Writable together with everything beneath them.
  trees: readonly string[];
  // Writable as exact paths; each also gets `<name>.lock`, git's lock file for it.
  lockedFiles: readonly string[];
  // Writable as exact paths, without a `.lock` companion.
  files: readonly string[];
  // Writable temporary files (jj's NamedTempFile, git's index.stash.<pid>), as name prefixes.
  temporaryPrefixes: readonly string[];
  // Directories with their own spec; anything else inside them is not allowlisted.
  children: Readonly<Record<string, DirectorySpec>>;
  // A nested git directory (non-colocated jj keeps one at .jj/repo/store/git).
  gitDirectories: readonly string[];
  // Names that must stay denied even while absent.
  absent: readonly AbsentName[];
}

interface AbsentName {
  name: string;
  // On Linux, srt mounts an empty placeholder file over a denied absent path while a command runs.
  // Some names break git or jj when they exist but are empty, so Linux skips them, or denies them
  // only while the named sibling exists.
  linux: "deny" | "skip" | { denyWhenPresent: string };
}

const EMPTY_SPEC: DirectorySpec = { trees: [], lockedFiles: [], files: [], temporaryPrefixes: [], children: {}, gitDirectories: [], absent: [] };

// The lists below come from running the git and jj command batteries of the sandbox integration tests
// in a scratch repository and recording every path inside the VCS directories that they wrote. A missing
// entry shows up as a <sandbox_violations> report, not as silent breakage.
const GIT_DIRECTORY: DirectorySpec = {
  ...EMPTY_SPEC,
  trees: ["objects", "refs", "logs", "reftable", "rr-cache", "rebase-merge", "rebase-apply", "sequencer"],
  lockedFiles: [
    "HEAD", "ORIG_HEAD", "FETCH_HEAD", "MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "MERGE_RR", "MERGE_AUTOSTASH",
    "AUTO_MERGE", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "COMMIT_EDITMSG", "TAG_EDITMSG", "SQUASH_MSG",
    "NOTES_EDITMSG", "BISECT_LOG", "BISECT_START", "BISECT_TERMS", "BISECT_NAMES", "BISECT_EXPECTED_REV",
    "BISECT_ANCESTORS_OK", "BISECT_HEAD", "BISECT_FIRST_PARENT", "index", "packed-refs", "shallow", "gc.pid", "gc.log",
  ],
  files: ["packed-refs.new"],
  temporaryPrefixes: ["index.stash."],
  children: {
    info: {
      ...EMPTY_SPEC,
      lockedFiles: ["refs"],
      // update-server-info writes info/refs_XXXXXX and renames it onto info/refs.
      temporaryPrefixes: ["refs_"],
      // Empty placeholders mean "no rules", which is what an absent file means too.
      absent: ["exclude", "attributes", "sparse-checkout", "grafts"].map((name) => ({ name, linux: "deny" as const })),
    },
  },
  absent: [
    // srt only protects .git/config beneath its working directory; .jj/repo/store/git/config needs this.
    { name: "config", linux: "deny" },
    // A placeholder file named hooks just means "no hooks".
    { name: "hooks", linux: "deny" },
    // git dies on an empty commondir ("failed to read"), also for the user's own git.
    { name: "commondir", linux: "skip" },
    { name: "config.worktree", linux: "deny" },
    { name: "modules", linux: "deny" },
    { name: "worktrees", linux: "deny" },
    { name: "remotes", linux: "deny" },
    { name: "branches", linux: "deny" },
  ],
};

const JJ_DIRECTORY: DirectorySpec = {
  ...EMPTY_SPEC,
  children: {
    repo: {
      ...EMPTY_SPEC,
      trees: ["op_store", "op_heads", "index"],
      files: ["git_import_export.lock"],
      children: { store: { ...EMPTY_SPEC, trees: ["extra"], gitDirectories: ["git"] } },
      // Without config-id an empty config.toml placeholder would make jj try to migrate it.
      absent: [{ name: "config.toml", linux: { denyWhenPresent: "config-id" } }, { name: "config-id", linux: "skip" }],
    },
    working_copy: { ...EMPTY_SPEC, files: ["checkout", "tree_state", "working_copy.lock"], temporaryPrefixes: [".tmp"] },
  },
  absent: [
    { name: "workspace-config.toml", linux: { denyWhenPresent: "workspace-config-id" } },
    { name: "workspace-config-id", linux: "skip" },
  ],
};

export interface DirectoryListing {
  path: string;
  entries: { name: string; directory: boolean }[];
}

export interface VcsLayout {
  repoRoot: string;
  // Every directory the specs describe that exists, keyed by absolute path.
  listings: ReadonlyMap<string, DirectoryListing>;
  // <repo>/.git when it is not a plain directory (linked worktree, submodule checkout or symlink): denied as a whole.
  gitFile?: string;
}

export interface VcsWriteRules {
  repositoryRoot: string;
  // darwin replacement for tree(<repo>): the repository minus .git/.jj, plus the allowlist.
  repositoryAllow: PathSelector[];
  // Literal paths to deny, both platforms.
  deny: string[];
  // The VCS directories that exist; an allow reaching any of them triggers `deny`.
  vcsDirectories: string[];
  // Linux: id files that are missing, so config.toml cannot be denied; drives the one-time warning.
  missingConfigIds: string[];
}

export async function scanVcsLayout(repoRoot: string): Promise<VcsLayout> {
  const listings = new Map<string, DirectoryListing>();
  const gitPath = join(repoRoot, ".git");
  const gitStatus = await lstat(gitPath).catch(ignoreMissing);
  if (gitStatus?.isDirectory()) await scanDirectory(gitPath, GIT_DIRECTORY, listings);
  await scanDirectory(join(repoRoot, ".jj"), JJ_DIRECTORY, listings);
  return { repoRoot, listings, gitFile: gitStatus && !gitStatus.isDirectory() ? gitPath : undefined };
}

export function vcsWriteRules(layout: VcsLayout, platform: Platform): VcsWriteRules {
  const { repoRoot, listings, gitFile } = layout;
  const roots = [
    [join(repoRoot, ".git"), GIT_DIRECTORY],
    [join(repoRoot, ".jj"), JJ_DIRECTORY],
  ] as const;
  const walks = roots.map(([path, spec]) => walkDirectory(path, spec, listings, platform));
  const vcsDirectories = [...roots.map(([path]) => path).filter((path) => listings.has(path)), ...(gitFile ? [gitFile] : [])];
  return {
    repositoryRoot: repoRoot,
    repositoryAllow: platform === "darwin" && vcsDirectories.length > 0 && !hasGlobCharacters(repoRoot)
      ? [...complementOfVcsDirectories(repoRoot), ...walks.flatMap((walk) => walk.allow)]
      : [],
    deny: [...new Set([...walks.flatMap((walk) => walk.deny), ...(gitFile ? [gitFile] : [])])],
    vcsDirectories,
    missingConfigIds: walks.flatMap((walk) => walk.missingConfigIds),
  };
}

async function scanDirectory(path: string, spec: DirectorySpec, listings: Map<string, DirectoryListing>): Promise<void> {
  const dirents = await readdir(path, { withFileTypes: true }).catch(ignoreMissing);
  if (!dirents) return;
  const entries = dirents.map((dirent) => ({ name: dirent.name, directory: dirent.isDirectory() }));
  listings.set(path, { path, entries });
  const directories = new Set(entries.filter((entry) => entry.directory).map((entry) => entry.name));
  const children = Object.entries(spec.children).map(([name, child]) => [name, child] as const);
  const nested = spec.gitDirectories.map((name) => [name, GIT_DIRECTORY] as const);
  await Promise.all([...children, ...nested].filter(([name]) => directories.has(name)).map(([name, child]) => scanDirectory(join(path, name), child, listings)));
}

// A directory that does not exist is simply not part of the layout. Dirents and stats of symlinks
// describe the link itself, so a symlinked entry never counts as a directory.
function ignoreMissing(error: unknown): undefined {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") return undefined;
  throw error;
}

interface Walk {
  allow: PathSelector[];
  deny: string[];
  missingConfigIds: string[];
}

function walkDirectory(path: string, spec: DirectorySpec, listings: ReadonlyMap<string, DirectoryListing>, platform: Platform): Walk {
  const listing = listings.get(path);
  if (!listing) return { allow: [], deny: [], missingConfigIds: [] };
  const names = new Set(listing.entries.map((entry) => entry.name));
  const nested = [...Object.entries(spec.children), ...spec.gitDirectories.map((name) => [name, GIT_DIRECTORY] as const)];
  const nestedWalks = nested.map(([name, child]) => walkDirectory(join(path, name), child, listings, platform));
  const deniedEntries = listing.entries
    .filter((entry) => {
      const isNested = nested.some(([name]) => name === entry.name);
      return isNested ? !entry.directory : !isAllowlisted(spec, entry.name);
    })
    .map((entry) => join(path, entry.name));
  const deniedAbsent = spec.absent
    .filter(({ name, linux }) => !names.has(name) && deniesAbsentName(linux, platform, names))
    .map(({ name }) => join(path, name));
  return {
    allow: [...allowlist(path, spec), ...nestedWalks.flatMap((walk) => walk.allow)],
    deny: [...deniedEntries, ...deniedAbsent, ...nestedWalks.flatMap((walk) => walk.deny)],
    missingConfigIds: [...missingIdFiles(path, spec, names, platform), ...nestedWalks.flatMap((walk) => walk.missingConfigIds)],
  };
}

function isAllowlisted(spec: DirectorySpec, name: string): boolean {
  if (spec.trees.includes(name) || spec.files.includes(name) || spec.lockedFiles.includes(name)) return true;
  if (name.endsWith(".lock") && spec.lockedFiles.includes(name.slice(0, -".lock".length))) return true;
  return spec.temporaryPrefixes.some((prefix) => name.startsWith(prefix));
}

function allowlist(path: string, spec: DirectorySpec): PathSelector[] {
  return [
    ...spec.trees.map((name) => tree(join(path, name))),
    ...spec.files.map((name) => exact(join(path, name))),
    ...spec.lockedFiles.flatMap((name) => [exact(join(path, name)), exact(join(path, `${name}.lock`))]),
    ...spec.temporaryPrefixes.map((prefix) => glob(path, `${prefix}*`)),
  ];
}

function deniesAbsentName(linux: AbsentName["linux"], platform: Platform, names: ReadonlySet<string>): boolean {
  if (platform === "darwin" || linux === "deny") return true;
  if (linux === "skip") return false;
  return names.has(linux.denyWhenPresent);
}

function missingIdFiles(path: string, spec: DirectorySpec, names: ReadonlySet<string>, platform: Platform): string[] {
  if (platform !== "linux") return [];
  return spec.absent
    .flatMap(({ linux }) => (typeof linux === "object" ? [linux.denyWhenPresent] : []))
    .filter((idFile) => !names.has(idFile))
    .map((idFile) => join(path, idFile));
}

// srt turns every glob into a regular expression and has no negated character classes, so "everything but
// .git and .jj" is spelled as positive classes that leave out the letter completing either name. Both cases
// are left out: Seatbelt let a write through an upper-cased spelling of an allowed lowercase path.
// The hyphen leads each class: Seatbelt's regex engine reads a trailing hyphen as the start of a range
// that swallows the dot.
const OTHER_CHARACTERS = "0-9_@,=~#%!&.";
const FIRST_CHARACTER = `[-A-Za-z0-9_@,=~#%!&]`;
const COMPLEMENT_PATTERNS = [
  `${FIRST_CHARACTER}*`,
  `.[-A-FH-IK-Za-fh-ik-z${OTHER_CHARACTERS}]*`,
  ".[gG]",
  `.[gG][-A-HJ-Za-hj-z${OTHER_CHARACTERS}]*`,
  ".[gG][iI]",
  `.[gG][iI][-A-SU-Za-su-z${OTHER_CHARACTERS}]*`,
  ".[gG][iI][tT]?*",
  ".[jJ]",
  `.[jJ][-A-IK-Za-ik-z${OTHER_CHARACTERS}]*`,
  ".[jJ][jJ]?*",
];

// srt matches a glob allow against the entry itself and drops a trailing `/**`, so what lies beneath an entry
// needs its own pattern: `/**/*` matches every path at any depth below it.
function complementOfVcsDirectories(repoRoot: string): PathSelector[] {
  return COMPLEMENT_PATTERNS.flatMap((pattern) => [glob(repoRoot, pattern), glob(repoRoot, `${pattern}/**/*`)]);
}

// srt reads a root path that contains these characters as a pattern itself.
function hasGlobCharacters(path: string): boolean {
  return /[*?[\]]/.test(path);
}
