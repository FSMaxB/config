import { lstat, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { errorCode } from "./errors.ts";

export async function resolveThroughSymlinks(target: string): Promise<string> {
  return await resolvePath(resolve(expandHome(target)), new Set());
}

export function expandHome(path: string, home: string = homedir()): string {
  return path === "~" || path.startsWith(`~${sep}`)
    ? join(home, path.slice(1))
    : path;
}

async function resolvePath(
  absolute: string,
  followedLinks: Set<string>,
): Promise<string> {
  return await resolveFromExisting(absolute, absolute, [], followedLinks);
}

// Walks up from `existing` until an entry exists, resolves it, and appends the `missing` tail again.
async function resolveFromExisting(
  absolute: string,
  existing: string,
  missing: readonly string[],
  followedLinks: Set<string>,
): Promise<string> {
  try {
    const stats = await lstat(existing);
    if (!stats.isSymbolicLink()) return join(await realpath(existing), ...missing);
    if (followedLinks.has(existing)) {
      throw new Error(`Cannot resolve ${absolute}: symbolic link cycle at ${existing}.`);
    }
    followedLinks.add(existing);
    const target = await readlink(existing);
    const linked = resolve(dirname(existing), target);
    return await resolvePath(join(linked, ...missing), followedLinks);
  } catch (error) {
    const code = errorCode(error);
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;

    const parent = dirname(existing);
    if (parent === existing) return absolute;
    return await resolveFromExisting(absolute, parent, [basename(existing), ...missing], followedLinks);
  }
}
