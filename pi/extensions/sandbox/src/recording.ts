import { dirname } from "node:path";
import { matchesRule, tree } from "../../lib/path-permission-rules.ts";
import type { AccessMode, PathSelector } from "../../lib/path-permission-rules.ts";
import type { EffectivePolicy } from "../../lib/path-permissions.ts";
import { contains } from "../../lib/repo.ts";
import { selectorText } from "./profiles.ts";
import { isSecretPath } from "./violations.ts";
import { hasGlobCharacters } from "./glob-characters.ts";

const SIBLINGS_BEFORE_COLLAPSE = 3;
const MIN_COMPONENTS_OUTSIDE_HOME = 3;
const MIN_COMPONENTS_INSIDE_HOME = 2;

const ACCESS_LINE = /\ballow\s+(file-(read|write)[\w-]*)\s+(\/.+?)\s*$/;

export function traceAccesses(lines: readonly string[]): TraceAccess[] {
  const accesses = new Map<string, TraceAccess>();
  for (const line of lines) {
    const match = ACCESS_LINE.exec(line);
    if (!match) continue;
    const mode = accessMode(match[2]);
    if (mode === undefined) continue;
    const access: TraceAccess = { mode, path: match[3] };
    accesses.set(`${access.mode}:${access.path}`, access);
  }
  return [...accesses.values()];
}

export function buildDraft(input: DraftInput): Draft {
  const { secrets: secretPaths, repositoryRoot, homeDirectory } = input;
  const secrets: TraceAccess[] = [];
  const protectedAccesses: TraceAccess[] = [];
  const kept: TraceAccess[] = [];
  for (const access of input.accesses) {
    if (contains(repositoryRoot, access.path)) continue;
    if (input.existing[access.mode].some((selector) => matchesRule(access.path, selector))) continue;
    if (isSecretPath(access.path, [...secretPaths])) {
      secrets.push(access);
      continue;
    }
    if (access.mode === "write" && input.policy.write.protected.some((selector) => matchesRule(access.path, selector))) {
      protectedAccesses.push(access);
      continue;
    }
    if (input.policy[access.mode].allow.some((selector) => matchesRule(access.path, selector))) continue;
    if (access.mode === "read" && input.toolchainRead.some((path) => !hasGlobCharacters(path) && contains(path, access.path))) continue;
    kept.push(access);
  }
  const entries = (["read", "write"] as const).flatMap((mode) => {
    const directories = kept
      .filter((access) => access.mode === mode)
      .map(({ path }) => (input.directories.has(path) ? path : dirname(path)));
    return withoutNested(collapseSiblings(directories, homeDirectory)).map((directory): DraftEntry => ({ mode, directory }));
  });
  return { entries, secrets, protected: protectedAccesses };
}

export interface DraftInput {
  accesses: readonly TraceAccess[];
  // Accessed paths that are directories, stat'ed by the caller.
  directories: ReadonlySet<string>;
  // currentPolicy() at stop time, profile grants excluded.
  policy: EffectivePolicy;
  toolchainRead: readonly string[];
  // The profile's current entries.
  existing: { read: readonly PathSelector[]; write: readonly PathSelector[] };
  secrets: readonly string[];
  repositoryRoot: string;
  homeDirectory: string;
}

export function draftText(draft: Draft, summary: { profile: string; commands: readonly string[]; accessCount: number }, homeDirectory: string): string {
  const header = [
    `# Recording for profile "${summary.profile}": ${summary.commands.length} commands, ${summary.accessCount} accesses outside the sandbox policy.`,
    ...summary.commands.map((command) => `#   !${firstLine(command)}`),
    '# One entry per line: "read <path>" or "write <path>"; <path> starts with / or ~/, and /** grants the whole tree.',
    "# Delete lines you don't want. Saving an empty text discards the recording.",
  ];
  const entries = draft.entries.map(({ mode, directory }) => `${mode} ${selectorText(tree(directory), homeDirectory)}`);
  const secrets = draft.secrets.map(({ mode, path }) => `# secret, only filesystem.secretRead in the profile file can grant it (reads only): ${mode} ${tilde(path, homeDirectory)}`);
  const protectedLines = draft.protected.flatMap(({ mode, path }) => [
    "# protected, uncomment the next line only if you mean it:",
    `# ${mode} ${tilde(path, homeDirectory)}`,
  ]);
  return [...header, ...entries, ...secrets, ...protectedLines].join("\n");
}

export interface Draft {
  entries: DraftEntry[];
  secrets: TraceAccess[];
  protected: TraceAccess[];
}

export interface TraceAccess {
  mode: AccessMode;
  path: string;
}

export interface DraftEntry {
  mode: AccessMode;
  directory: string;
}

const ENTRY_LINE = /^(read|write)\s+(\S.*)$/;

export function parseDraftText(text: string): { entries: { mode: AccessMode; entry: string }[]; errors: string[] } {
  const entries: { mode: AccessMode; entry: string }[] = [];
  const errors: string[] = [];
  for (const [index, rawLine] of text.split("\n").entries()) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = ENTRY_LINE.exec(line);
    const mode = match ? accessMode(match[1]) : undefined;
    if (!match || mode === undefined) {
      errors.push(`line ${index + 1}: expected "read <path>" or "write <path>", got "${line}"`);
      continue;
    }
    const entry = match[2].trim();
    if (!entry.startsWith("/") && !entry.startsWith("~/")) {
      errors.push(`line ${index + 1}: the path must start with / or ~/, got "${entry}"`);
      continue;
    }
    entries.push({ mode, entry });
  }
  return { entries, errors };
}

function accessMode(text: string | undefined): AccessMode | undefined {
  return text === "read" || text === "write" ? text : undefined;
}

// Repeats until nothing changes, so a collapsed parent can itself collapse into its own parent.
function collapseSiblings(directories: readonly string[], homeDirectory: string): string[] {
  const current = [...new Set(directories)];
  const byParent = new Map<string, string[]>();
  for (const directory of current) {
    const parent = dirname(directory);
    byParent.set(parent, [...(byParent.get(parent) ?? []), directory]);
  }
  const collapsing = [...byParent].filter(([parent, children]) => children.length >= SIBLINGS_BEFORE_COLLAPSE && isCollapsible(parent, homeDirectory));
  if (collapsing.length === 0) return current;
  const replaced = new Set(collapsing.flatMap(([, children]) => children));
  return collapseSiblings([...current.filter((directory) => !replaced.has(directory)), ...collapsing.map(([parent]) => parent)], homeDirectory);
}

// Never `/`, `/Users`, `/private/var`, `~` or `~/Library`: a collapse that wide would grant far more than was used.
function isCollapsible(directory: string, homeDirectory: string): boolean {
  if (contains(homeDirectory, directory)) return components(directory.slice(homeDirectory.length)) >= MIN_COMPONENTS_INSIDE_HOME;
  return components(directory) >= MIN_COMPONENTS_OUTSIDE_HOME;
}

function components(path: string): number {
  return path.split("/").filter((component) => component !== "").length;
}

function withoutNested(directories: readonly string[]): string[] {
  return directories
    .filter((directory) => !directories.some((other) => other !== directory && contains(other, directory)))
    .sort();
}


function firstLine(command: string): string {
  const [first = ""] = command.split("\n");
  return command.includes("\n") ? `${first} …` : first;
}

function tilde(path: string, homeDirectory: string): string {
  return path.startsWith(`${homeDirectory}/`) ? `~${path.slice(homeDirectory.length)}` : path;
}
