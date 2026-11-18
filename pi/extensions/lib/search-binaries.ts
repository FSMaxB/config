import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findAncestorWith } from "./repo.ts";

// Short enough that a binary installed mid-session is picked up without a restart.
const MISSING_RETRY_MILLISECONDS = 60_000;

const lookups = new Map<string, BinaryLookup>();

type BinaryLookup = { kind: "found"; path: string } | { kind: "missing"; since: number };

export function locateBinary(name: string, fallbackNames: readonly string[] = [], now: () => number = Date.now): string {
  const cached = lookups.get(name);
  if (cached?.kind === "found") return cached.path;
  if (cached?.kind === "missing" && now() - cached.since < MISSING_RETRY_MILLISECONDS) throw notAvailable(name);

  // pi's own tool downloader puts binaries here, so prefer it before the PATH.
  const downloaded = join(homedir(), ".pi", "agent", "bin", name);
  const candidates = existsSync(downloaded)
    ? [downloaded, name, ...fallbackNames]
    : [name, ...fallbackNames];

  for (const candidate of candidates) {
    const { status } = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (status === 0) {
      lookups.set(name, { kind: "found", path: candidate });
      return candidate;
    }
  }
  lookups.set(name, { kind: "missing", since: now() });
  throw notAvailable(name);
}

function notAvailable(name: string): Error {
  return new Error(`${name} is not available. Install it or run a pi built-in ${name} tool once so pi downloads it.`);
}

// fd and rg only honor .gitignore inside a git repository unless told otherwise. The tools pass
// --no-require-git outside one so nested .gitignore files still apply, while inside one fd's
// default git-aware behavior keeps parent .gitignore rules from crossing nested repo boundaries:
// https://github.com/earendil-works/pi/issues/5960
export function insideGitRepository(searchPath: string): boolean {
  return findAncestorWith(searchPath, [".git"]) !== undefined;
}
