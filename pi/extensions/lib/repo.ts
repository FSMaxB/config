import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
export { expandHome, resolveThroughSymlinks } from "./path-resolution.ts";

export interface VcsInfo {
  kind: "jj" | "git" | "none";
  root: string;
  colocated: boolean;
}

export function findRepoRoot(from: string = process.cwd()): string {
  return findVcsRoot(from) ?? resolve(from);
}

export function detectVcs(from: string = process.cwd()): VcsInfo {
  const root = findVcsRoot(from);
  if (!root) return { kind: "none", root: resolve(from), colocated: false };

  const jj = existsSync(join(root, ".jj"));
  const git = existsSync(join(root, ".git"));
  return { kind: jj ? "jj" : "git", root, colocated: jj && git };
}

export function isVcsInternal(path: string): boolean {
  return path
    .split(sep)
    .some((component) => component === ".git" || component === ".jj");
}

function findVcsRoot(from: string): string | undefined {
  let current = resolve(from);
  while (true) {
    if (existsSync(join(current, ".jj")) || existsSync(join(current, ".git")))
      return current;

    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}


// Keep this in one place so file tools and other extensions agree on where project memory
// lives. Claude Code derives the directory from the cwd.
export function memoryDirectory(): string {
  const slug = process.cwd().replace(/[^a-zA-Z0-9]/g, "-");
  return join(homedir(), ".claude", "projects", slug, "memory");
}

export function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}

