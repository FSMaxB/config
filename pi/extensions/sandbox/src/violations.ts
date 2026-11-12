import type { FilesystemConfig } from "@anthropic-ai/sandbox-runtime";
import { contains, resolveThroughSymlinks } from "../../lib/repo.ts";

export interface PathViolation {
  mode: "read" | "write";
  path: string;
}

// macOS: `Sandbox: bash(1234) deny(1) file-write-create /Users/max/x`
// Linux: `deny openat /home/max/x`
const VIOLATION = /deny(?:\(\d+\))?\s+(\S+)\s+(\/.+?)\s*$/;

export function pathViolations(lines: string[]): PathViolation[] {
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
  violations: PathViolation[],
  filesystem: Pick<FilesystemConfig, "denyRead" | "allowWrite">,
  platform: "darwin" | "linux",
): PathViolation[] {
  if (platform !== "linux") return [];
  const literal = (entries: readonly string[]) => entries.filter((entry) => !/[*?[\]]/.test(entry));
  const denied = literal(filesystem.denyRead);
  const writable = literal(filesystem.allowWrite ?? []);
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

export function isSecretPath(path: string, secrets: string[]): boolean {
  return secrets.some((secret) => contains(secret, path));
}

// A violation path may travel through a symlink into a secret tree; resolve first so the report
// names the real secret path. The existing parent is resolved for missing paths, so write-create
// violations are covered too.
export async function isSecretPathThroughSymlinks(path: string, secrets: string[]): Promise<boolean> {
  return isSecretPath(await resolveThroughSymlinks(path), secrets);
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
