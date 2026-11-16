import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export type RealPath = (path: string) => string;

/** Mirrors the file tools: strips a leading `@`, expands `~`, resolves against cwd. */
export function resolveToolPath(rawPath: string, cwd: string): string {
  const withoutAt = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
  const expanded =
    withoutAt === "~" ? homedir() : withoutAt.startsWith("~/") ? homedir() + withoutAt.slice(1) : withoutAt;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

export function safeRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
