import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { expandHome } from "./path-resolution.ts";

export type RealPath = (path: string) => string;

/** Mirrors the file tools: strips a leading `@`, expands `~`, resolves against cwd. */
export function resolveToolPath(rawPath: string, cwd: string, home: string = homedir()): string {
  const withoutAt = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
  const expanded = expandHome(withoutAt, home);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

export function safeRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
