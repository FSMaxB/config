import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { BranchEntry } from "./section.ts";

export const LOADED_SKILL_ENTRY = "loaded-skill";

export type LoadedSkillData = { name: string };

export type SkillLevel = "repo" | "user";
export type LoadedSkill = { name: string; level: SkillLevel };

/** Maps the realpath of each skill's SKILL.md to the skill. */
export type SkillIndex = Map<string, LoadedSkill>;

export type CommandInfo = { name: string; source: string; sourceInfo: { path: string; scope: string } };
export type RealPath = (path: string) => string;

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

/** The skill a successful `read` of `rawPath` loaded, if any. */
export function skillForReadPath(
  index: SkillIndex,
  rawPath: unknown,
  cwd: string,
  realPath: RealPath = safeRealPath,
): LoadedSkill | undefined {
  if (typeof rawPath !== "string" || rawPath === "") return undefined;
  return index.get(realPath(resolveReadPath(rawPath, cwd)));
}

/** The skill from a `/skill:name` expansion: `<skill name="NAME" location="...">`. */
export function skillFromUserContent(index: SkillIndex, content: unknown): LoadedSkill | undefined {
  const match = /^<skill name="([^"]+)" location="[^"]+">/.exec(firstText(content));
  if (!match) return undefined;
  return findByName(index, match[1]);
}

/** Skills recorded on the branch, in load order, without duplicates. Names missing from the index count as user skills. */
export function loadedSkillsOnBranch(entries: readonly BranchEntry[], index: SkillIndex): LoadedSkill[] {
  const skills: LoadedSkill[] = [];
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== LOADED_SKILL_ENTRY) continue;
    const name = (entry.data as Partial<LoadedSkillData> | undefined)?.name;
    if (typeof name !== "string" || skills.some((skill) => skill.name === name)) continue;
    skills.push(findByName(index, name) ?? { name, level: "user" });
  }
  return skills;
}

// Not decided by path: ~/.pi/agent/skills links into ~/config/pi/skills, so a path check would call user skills repo skills there.
function levelForScope(scope: string): SkillLevel {
  return scope === "project" ? "repo" : "user";
}

function findByName(index: SkillIndex, name: string): LoadedSkill | undefined {
  return [...index.values()].find((skill) => skill.name === name);
}

/** Mirrors the read tool: strips a leading `@`, expands `~`, resolves against cwd. */
function resolveReadPath(rawPath: string, cwd: string): string {
  const withoutAt = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
  const expanded =
    withoutAt === "~" ? homedir() : withoutAt.startsWith("~/") ? homedir() + withoutAt.slice(1) : withoutAt;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function safeRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function firstText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const block = content.find((item) => item?.type === "text" && typeof item.text === "string");
  return block?.text ?? "";
}
