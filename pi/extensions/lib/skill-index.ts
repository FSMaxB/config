import { dirname, relative, sep } from "node:path";
import { resolveToolPath, safeRealPath } from "./tool-path.ts";
import type { RealPath } from "./tool-path.ts";

export type SkillReference = Extract<SkillLoad, { kind: "reference" }>;
export function buildSkillIndex(commands: readonly CommandInfo[], realPath: RealPath = safeRealPath): SkillIndex {
  const index: SkillIndex = new Map();
  for (const command of commands) {
    if (command.source !== "skill") continue;
    index.set(realPath(command.sourceInfo.path), {
      name: command.name.replace(/^skill:/, ""),
      level: levelForScope(command.sourceInfo.scope),
    });
  }
  return index;
}

export interface CommandInfo { name: string; source: string; sourceInfo: { path: string; scope: string } }

/** What a successful `read` of `rawPath` loaded, if anything. */
export function skillLoadForReadPath(
  index: SkillIndex,
  rawPath: unknown,
  cwd: string,
  realPath: RealPath = safeRealPath,
): SkillLoad | undefined {
  if (typeof rawPath !== "string" || rawPath === "") return undefined;
  const path = realPath(resolveToolPath(rawPath, cwd));
  const skill = index.get(path);
  if (skill !== undefined) return { kind: "skill", skill };
  return referenceLoad(index, path);
}

/** The `references/` directory and the `.md` extension are conventions for a skill's reference files, so they add no information to a row. */
export function skillReferenceLabel(path: string): string {
  const prefix = `references${sep}`;
  const withoutDirectory = path.startsWith(prefix) ? path.slice(prefix.length) : path;
  return withoutDirectory.replace(/\.md$/, "");
}

/** A file inside a skill's directory, other than its SKILL.md. The deepest skill directory wins. */
function referenceLoad(index: SkillIndex, path: string): SkillLoad | undefined {
  let best: { directory: string; skill: Skill } | undefined;
  for (const [skillFile, skill] of index) {
    const directory = dirname(skillFile);
    if (!path.startsWith(directory + sep)) continue;
    if (best === undefined || directory.length > best.directory.length) best = { directory, skill };
  }
  if (best === undefined) return undefined;
  return { kind: "reference", skill: best.skill, path: relative(best.directory, path) };
}

/** Maps the realpath of each skill's SKILL.md to the skill. */
export type SkillIndex = Map<string, Skill>;

/** What a read or a /skill:name expansion loaded. */
export type SkillLoad = { kind: "skill"; skill: Skill } | { kind: "reference"; skill: Skill; path: string };
export interface Skill { name: string; level: SkillLevel }

// Not decided by path: ~/.pi/agent/skills links into ~/config/pi/skills, so a path check would call user skills repo skills there.
function levelForScope(scope: string): SkillLevel {
  return scope === "project" ? "repo" : "user";
}

export type SkillLevel = "repo" | "user";
