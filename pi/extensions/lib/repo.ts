import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
export { resolveThroughSymlinks } from "./path-resolution.ts";

export function findRepositoryRoot(from: string = process.cwd()): string {
  return findVcsRoot(from) ?? resolve(from);
}

export function detectVcs(from: string = process.cwd()): VcsInfo {
  const root = findVcsRoot(from);
  if (!root) return { kind: "none", root: resolve(from) };
  if (!existsSync(join(root, ".jj"))) return { kind: "git", root };
  return { kind: "jj", root, colocated: existsSync(join(root, ".git")) };
}

// Without a repository, root is the directory the detection started from.
export type VcsInfo =
  | { kind: "none"; root: string }
  | { kind: "git"; root: string }
  // A colocated jj repository also has a .git directory that jj keeps in sync.
  | { kind: "jj"; root: string; colocated: boolean };

export function isVcsInternal(path: string): boolean {
  return path
    .split(sep)
    .some((component) => component === ".git" || component === ".jj");
}

function findVcsRoot(from: string): string | undefined {
  return findAncestorWith(from, [".jj", ".git"]);
}

// The nearest directory from `from` upwards that contains one of the marker entries.
export function findAncestorWith(from: string, markers: readonly string[]): string | undefined {
  for (const directory of ancestorDirectories(from)) {
    if (markers.some((marker) => existsSync(join(directory, marker)))) return directory;
  }
  return undefined;
}

/** `from` and each of its ancestors up to the filesystem root, nearest first. */
export function* ancestorDirectories(from: string): Generator<string, void, undefined> {
  let current = resolve(from);
  let parent = dirname(current);
  while (parent !== current) {
    yield current;
    current = parent;
    parent = dirname(current);
  }
  yield current;
}

// Keep this in one place so file tools and other extensions agree on where project memory
// lives. Claude Code derives the directory from the cwd.
export function memoryDirectory(cwd: string = process.cwd(), home: string = homedir()): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return join(home, ".claude", "projects", slug, "memory");
}

export function contains(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))
  );
}

