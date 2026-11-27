import { basename, dirname, join } from "node:path";
import type { FilesystemConfig } from "@anthropic-ai/sandbox-runtime";
import type { AccessMode } from "../../lib/path-permission-rules.ts";
import { contains, resolveThroughSymlinks } from "../../lib/repo.ts";
import type { Platform } from "./platform.ts";
import { hasGlobCharacters } from "./glob-characters.ts";

// macOS: `Sandbox: bash(1234) deny(1) file-write-create /Users/max/x`
// Linux: `deny openat /home/max/x`
const VIOLATION = /deny(?:\(\d+\))?\s+(\S+)\s+(\/.+?)\s*$/;

// A colocated repository keeps its git directory at .git, a non-colocated jj repository at .jj/repo/store/git.
const GIT_INFO_DIRECTORIES = [".git/info", ".jj/repo/store/git/info"];

export function pathViolations(lines: readonly string[]): PathViolation[] {
  const violations = new Map<string, PathViolation>();
  for (const line of lines) {
    const violation = parseViolation(line);
    if (!violation) continue;
    violations.set(`${violation.mode}:${violation.path}`, violation);
  }
  return [...violations.values()];
}

// Linux masks each read-denied directory with a writable tmpfs, so a write there succeeds and is thrown away
// when the sandbox exits. macOS refuses the write outright, so nothing is ever discarded there. Glob entries are
// skipped: srt drops write globs on Linux and a read-deny glob is a user rule.
export function discardedWrites(
  violations: readonly PathViolation[],
  filesystem: Pick<FilesystemConfig, "denyRead" | "allowWrite">,
  platform: Platform,
): PathViolation[] {
  if (platform !== "linux") return [];
  const literal = (entries: readonly string[]): string[] => entries.filter((entry) => !hasGlobCharacters(entry));
  const denied = literal(filesystem.denyRead);
  const writable = literal(filesystem.allowWrite);
  return violations.filter(({ mode, path }) =>
    mode === "write" && denied.some((root) => contains(root, path)) && !writable.some((root) => contains(root, path)));
}

// After deleting a file, jj also tries to remove the file's parent directory, the repository root included. On
// macOS only the root's entries are writable, not the root itself, so Seatbelt denies that unlink. The root is never
// empty, so the removal fails either way and jj ignores the error. Linux reports syscall names, never this one.
export function isRepositoryRootRemoval(line: string, repositoryRoot: string): boolean {
  const match = VIOLATION.exec(line);
  return match?.[1] === "file-write-unlink" && match[2] === repositoryRoot;
}

// Linux keeps .git/info read-only as a whole (see vcs-policy.ts), so git gc and git repack cannot refresh info/refs,
// which only dumb-HTTP serving reads. git reports the failure itself and carries on, and no grant can lift the deny.
export function isServerInfoRefresh(line: string, repositoryRoot: string): boolean {
  const violation = parseViolation(line);
  if (violation?.mode !== "write") return false;
  const name = basename(violation.path);
  if (name !== "refs" && !name.startsWith("refs_")) return false;
  return GIT_INFO_DIRECTORIES.some((directory) => dirname(violation.path) === join(repositoryRoot, directory));
}

// Bash before 5.1 creates here-document temp files named sh-thd-<number> outside $TMPDIR, in the current
// directory when nothing better is writable; bash 5.1+ only falls back to such files above the pipe size.
export function isHereDocumentTemporaryFile(line: string): boolean {
  const violation = parseViolation(line);
  return violation?.mode === "write" && /^sh-thd[-.][A-Za-z0-9]+$/.test(basename(violation.path));
}

// The secret a violation path names, if any. Seatbelt logs an operation on a symlink itself under the link's path, so
// a secret-listed link counts as logged; a path that travels through a symlink into a secret tree counts resolved,
// and the report names the real secret path.
export async function secretViolationPath(path: string, secrets: readonly string[]): Promise<string | undefined> {
  if (isSecretPath(path, secrets)) return path;
  const resolved = await resolveThroughSymlinks(path);
  return isSecretPath(resolved, secrets) ? resolved : undefined;
}

export function isSecretPath(path: string, secrets: readonly string[]): boolean {
  return secrets.some((secret) => contains(secret, path));
}

function parseViolation(line: string): PathViolation | undefined {
  const match = VIOLATION.exec(line);
  if (!match) return undefined;
  const [, operation, path] = match;
  // Seatbelt operations are hyphenated (`file-read-data`, `process-exec`); Linux reports bare syscall names.
  if (operation.includes("-")) {
    if (operation.startsWith("file-read")) return { mode: "read", path };
    return operation.startsWith("file-write") ? { mode: "write", path } : undefined;
  }
  // The Linux observer only sees write-side syscalls.
  return { mode: "write", path };
}

export interface PathViolation {
  mode: AccessMode;
  path: string;
}
