import { sep } from "node:path";
import { expandHome, resolveThroughSymlinks } from "./path-resolution.ts";
import { exact, glob, tree, type PathSelector } from "./path-permission-rules.ts";

const GLOB_COMPONENT = /[*?\[\]{}]|\([^)]*[?+*@!]\)|\([^)]*\)/;

export async function normalizePathSelector(input: string, cwd: string): Promise<PathSelector> {
  const expanded = expandHome(input);
  const absolute = expanded.startsWith(sep) ? expanded : `${cwd}${sep}${expanded}`;
  const components = absolute.split(sep);
  const globIndex = components.findIndex((component) => GLOB_COMPONENT.test(component));
  if (globIndex < 0) return exact(await resolveThroughSymlinks(absolute));
  if (components.slice(globIndex + 1).some((component) => component === "." || component === "..")) throw new Error("Path patterns cannot contain . or .. after a glob component");
  const prefix = components.slice(0, globIndex).join(sep) || sep;
  const base = await resolveThroughSymlinks(prefix);
  const pattern = components.slice(globIndex).join(sep);
  if (pattern === `**`) return tree(base);
  return glob(base, pattern);
}
