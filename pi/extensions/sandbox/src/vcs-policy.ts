import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { exact, glob, tree } from "../../lib/path-permission-rules.ts";
import type { PathSelector } from "../../lib/path-permission-rules.ts";
import type { Platform } from "./platform.ts";
import { errorCode } from "../../lib/errors.ts";
import { hasGlobCharacters } from "./glob-characters.ts";

const EMPTY_SPEC: DirectorySpec = { linux: "walk", trees: [], lockedFiles: [], files: [], temporaryPrefixes: [], children: {}, gitDirectories: [], absent: [] };

// srt covers the first absent component of a denied path with an empty read-only directory when the path goes on
// beneath it, and with a /dev/null file when it does not. Denying this entry gets the directory.
const DIRECTORY_PLACEHOLDER_ENTRY = ".sandbox-placeholder";

// The lists below come from running the git and jj command batteries of the sandbox integration tests
// in a scratch repository and recording every path inside the VCS directories that they wrote. A missing
// entry shows up as a <sandbox_violations> report, not as silent breakage.
const GIT_DIRECTORY: DirectorySpec = {
  ...EMPTY_SPEC,
  trees: ["objects", "refs", "logs", "reftable", "rr-cache", "rebase-merge", "rebase-apply", "sequencer", "lfs"],
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
      // Absent files git reads here would need placeholders, which it cannot read and warns about on most commands.
      // The cost is that git gc and git repack cannot refresh info/refs, which only dumb-HTTP serving reads.
      linux: "read-only",
      lockedFiles: ["refs"],
      // update-server-info writes info/refs_XXXXXX and renames it onto info/refs.
      temporaryPrefixes: ["refs_"],
      // Only darwin walks this spec; Linux keeps the whole directory read-only.
      absent: ["exclude", "attributes", "sparse-checkout", "grafts"].map((name) => ({ name, linux: "file" as const })),
    },
  },
  absent: [
    // srt only protects .git/config beneath its working directory; .jj/repo/store/git/config needs this.
    { name: "config", linux: "file" },
    // An empty hooks directory means "no hooks".
    { name: "hooks", linux: "directory" },
    // git dies on a commondir it cannot read ("failed to read"), also for the user's own git.
    { name: "commondir", linux: "skip" },
    { name: "info", linux: "directory" },
    { name: "config.worktree", linux: "file" },
    { name: "modules", linux: "directory" },
    // jj's ref export opens worktrees as a directory and fails on anything else.
    { name: "worktrees", linux: "directory" },
    { name: "remotes", linux: "directory" },
    { name: "branches", linux: "directory" },
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

export async function scanVcsLayout(repositoryRoot: string): Promise<VcsLayout> {
  const listings = new Map<string, DirectoryListing>();
  const gitPath = join(repositoryRoot, ".git");
  const gitStatus = await lstat(gitPath).catch(ignoreMissing);
  if (gitStatus?.isDirectory()) await scanDirectory(gitPath, GIT_DIRECTORY, listings);
  await scanDirectory(join(repositoryRoot, ".jj"), JJ_DIRECTORY, listings);
  return { repoRoot: repositoryRoot, listings, gitFile: gitStatus && !gitStatus.isDirectory() ? gitPath : undefined };
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

export interface VcsLayout {
  repoRoot: string;
  // Every directory the specs describe that exists, keyed by absolute path.
  listings: ReadonlyMap<string, DirectoryListing>;
  // <repo>/.git when it is not a plain directory (linked worktree, submodule checkout or symlink): denied as a whole.
  gitFile: string | undefined;
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
  const code = errorCode(error);
  if (code === "ENOENT" || code === "ENOTDIR") return undefined;
  throw error;
}

function walkDirectory(path: string, spec: DirectorySpec, listings: ReadonlyMap<string, DirectoryListing>, platform: Platform): Walk {
  const listing = listings.get(path);
  if (!listing) return { allow: [], deny: [], missingConfigIds: [] };
  if (platform === "linux" && spec.linux === "read-only") return { allow: [], deny: [path], missingConfigIds: [] };
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
    .filter(({ name }) => !names.has(name))
    .flatMap((absent) => absentDenyPaths(path, absent, platform, names));
  return {
    allow: [...allowlist(path, spec), ...nestedWalks.flatMap((walk) => walk.allow)],
    deny: [...deniedEntries, ...deniedAbsent, ...nestedWalks.flatMap((walk) => walk.deny)],
    missingConfigIds: [...missingIdFiles(path, spec, names, platform), ...nestedWalks.flatMap((walk) => walk.missingConfigIds)],
  };
}

function absentDenyPaths(directory: string, { name, linux }: AbsentName, platform: Platform, names: ReadonlySet<string>): string[] {
  const path = join(directory, name);
  if (platform === "darwin") return [path];
  if (linux === "skip") return [];
  if (linux === "file") return [path];
  if (linux === "directory") return [join(path, DIRECTORY_PLACEHOLDER_ENTRY)];
  return names.has(linux.denyWhenPresent) ? [path] : [];
}

export interface DirectoryListing {
  path: string;
  entries: { name: string; directory: boolean }[];
}

interface Walk {
  allow: PathSelector[];
  deny: string[];
  missingConfigIds: string[];
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

function missingIdFiles(path: string, spec: DirectorySpec, names: ReadonlySet<string>, platform: Platform): string[] {
  if (platform !== "linux") return [];
  return spec.absent
    .flatMap(({ linux }) => (typeof linux === "object" ? [linux.denyWhenPresent] : []))
    .filter((idFile) => !names.has(idFile))
    .map((idFile) => join(path, idFile));
}


// What git and jj write during normal operation, relative to the directory each spec describes.
interface DirectorySpec {
  // How Linux protects the directory while it exists: "walk" applies this spec to its entries, "read-only" denies the
  // directory as a whole and leaves the spec to darwin.
  linux: "walk" | "read-only";
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
  // On Linux, srt mounts a placeholder over a denied absent path while a command runs: /dev/null, which bubblewrap
  // mounts nodev so that reading it fails with EACCES, or an empty read-only directory when the denied path goes on
  // beneath the name. "file" denies the name itself, "directory" an entry beneath it, "skip" leaves the name alone,
  // and denyWhenPresent denies the name only while the named sibling exists. Some names break git or jj as an
  // unreadable file, so they are skipped or denied only conditionally.
  linux: "file" | "directory" | "skip" | { denyWhenPresent: string };
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
function complementOfVcsDirectories(repositoryRoot: string): PathSelector[] {
  return COMPLEMENT_PATTERNS.flatMap((pattern) => [glob(repositoryRoot, pattern), glob(repositoryRoot, `${pattern}/**/*`)]);
}
