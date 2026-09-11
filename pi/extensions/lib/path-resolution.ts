import { lstat, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

export async function resolveThroughSymlinks(target: string): Promise<string> {
  return await resolvePath(resolve(expandHome(target)), new Set());
}

export function expandHome(path: string): string {
  return path === "~" || path.startsWith(`~${sep}`)
    ? join(homedir(), path.slice(1))
    : path;
}

async function resolvePath(
  absolute: string,
  followedLinks: Set<string>,
): Promise<string> {
  const missing: string[] = [];
  let existing = absolute;

  while (true) {
    try {
      const stats = await lstat(existing);
      if (stats.isSymbolicLink()) {
        if (followedLinks.has(existing)) {
          throw new Error(`Cannot resolve ${absolute}: symbolic link cycle at ${existing}.`);
        }
        followedLinks.add(existing);
        const target = await readlink(existing);
        const linked = resolve(dirname(existing), target);
        return await resolvePath(join(linked, ...missing), followedLinks);
      }
      return join(await realpath(existing), ...missing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;

      const parent = dirname(existing);
      if (parent === existing) return absolute;
      missing.unshift(basename(existing));
      existing = parent;
    }
  }
}
