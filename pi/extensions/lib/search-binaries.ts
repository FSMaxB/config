import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const binaryCache = new Map<string, string>();
const missingSince = new Map<string, number>();

export function locateBinary(name: string, fallbackNames: string[] = []): string {
  // Short enough that a binary installed mid-session is picked up without a restart.
  const MISSING_RETRY_MILLISECONDS = 60_000;
  const cached = binaryCache.get(name);
  if (cached) return cached;
  const missing = missingSince.get(name);
  if (missing !== undefined && Date.now() - missing < MISSING_RETRY_MILLISECONDS) throw notAvailable(name);

  // pi's own tool downloader puts binaries here, so prefer it before the PATH.
  const downloaded = join(homedir(), ".pi", "agent", "bin", name);
  const candidates = existsSync(downloaded)
    ? [downloaded, name, ...fallbackNames]
    : [name, ...fallbackNames];

  for (const candidate of candidates) {
    const { status } = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (status === 0) {
      binaryCache.set(name, candidate);
      return candidate;
    }
  }
  missingSince.set(name, Date.now());
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
  for (let current = searchPath; ; ) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}
