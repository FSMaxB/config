import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { BranchEntry } from "./section.ts";

export const LOADED_SKILL_ENTRY = "loaded-skill";

export type LoadedSkillData = { name: string };

/** Maps the realpath of each skill's SKILL.md to the skill name. */
export type SkillIndex = Map<string, string>;

export type CommandInfo = { name: string; source: string; sourceInfo: { path: string } };
export type RealPath = (path: string) => string;

export function buildSkillIndex(commands: readonly CommandInfo[], realPath: RealPath = safeRealPath): SkillIndex {
  const index: SkillIndex = new Map();
  for (const command of commands) {
    if (command.source !== "skill") continue;
    index.set(realPath(command.sourceInfo.path), command.name.replace(/^skill:/, ""));
  }
  return index;
}

/** Name of the skill a successful `read` of `rawPath` loaded, if any. */
export function skillForReadPath(
  index: SkillIndex,
  rawPath: unknown,
  cwd: string,
  realPath: RealPath = safeRealPath,
): string | undefined {
  if (typeof rawPath !== "string" || rawPath === "") return undefined;
  return index.get(realPath(resolveReadPath(rawPath, cwd)));
}

/** Name from a `/skill:name` expansion: `<skill name="NAME" location="...">`. */
export function skillFromUserContent(index: SkillIndex, content: unknown): string | undefined {
  const match = /^<skill name="([^"]+)" location="[^"]+">/.exec(firstText(content));
  if (!match) return undefined;
  const name = match[1];
  return [...index.values()].includes(name) ? name : undefined;
}

/** Skill names recorded on the branch, in load order, without duplicates. */
export function loadedSkillsOnBranch(entries: readonly BranchEntry[]): string[] {
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== LOADED_SKILL_ENTRY) continue;
    const name = (entry.data as Partial<LoadedSkillData> | undefined)?.name;
    if (typeof name === "string" && !names.includes(name)) names.push(name);
  }
  return names;
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
