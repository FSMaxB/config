import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { ItemTone, type PanelItem } from "./panel.ts";
import type { BranchEntry } from "./section.ts";

export const LOADED_SKILL_ENTRY = "loaded-skill";
export const LOADED_SKILL_REFERENCE_ENTRY = "loaded-skill-reference";

export type LoadedSkillData = { name: string };
/** `path` is relative to the skill's directory. */
export type LoadedSkillReferenceData = { skill: string; path: string };

export type SkillLevel = "repo" | "user";
export type Skill = { name: string; level: SkillLevel };

/** Maps the realpath of each skill's SKILL.md to the skill. */
export type SkillIndex = Map<string, Skill>;

/** What a read or a /skill:name expansion loaded. */
export type SkillLoad = { kind: "skill"; skill: Skill } | { kind: "reference"; skill: Skill; path: string };

/** Whether the skill's own SKILL.md was loaded, or only some of its other files. */
export const SkillState = { Loaded: "loaded", ReferencesOnly: "references-only" } as const;
export type SkillState = (typeof SkillState)[keyof typeof SkillState];

export type SkillOnBranch = { skill: Skill; state: SkillState; references: readonly string[] };

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

/** What a successful `read` of `rawPath` loaded, if anything. */
export function skillLoadForReadPath(
  index: SkillIndex,
  rawPath: unknown,
  cwd: string,
  realPath: RealPath = safeRealPath,
): SkillLoad | undefined {
  if (typeof rawPath !== "string" || rawPath === "") return undefined;
  const path = realPath(resolveReadPath(rawPath, cwd));
  const skill = index.get(path);
  if (skill !== undefined) return { kind: "skill", skill };
  return referenceLoad(index, path);
}

/** The skill from a `/skill:name` expansion: `<skill name="NAME" location="...">`. */
export function skillLoadFromUserContent(index: SkillIndex, content: unknown): SkillLoad | undefined {
  const match = /^<skill name="([^"]+)" location="[^"]+">/.exec(firstText(content));
  if (!match) return undefined;
  const skill = findByName(index, match[1]);
  return skill === undefined ? undefined : { kind: "skill", skill };
}

/** Skills recorded on the branch, in first-load order. Names missing from the index count as user skills. */
export function skillsOnBranch(entries: readonly BranchEntry[], index: SkillIndex): readonly SkillOnBranch[] {
  let skills: readonly SkillOnBranch[] = [];
  for (const entry of entries) {
    const load = loadFromEntry(entry, index);
    if (load === undefined) continue;
    skills = applySkillLoad(skills, load) ?? skills;
  }
  return skills;
}

/** The skills after `load`, or undefined when it changes nothing (already loaded, reference already listed). */
export function applySkillLoad(
  skills: readonly SkillOnBranch[],
  load: SkillLoad,
): readonly SkillOnBranch[] | undefined {
  const position = skills.findIndex((known) => known.skill.name === load.skill.name);
  const current = position === -1 ? undefined : skills[position];
  const next =
    load.kind === "skill" ? withSkillLoaded(load.skill, current) : withReference(load.skill, load.path, current);
  if (next === undefined) return undefined;
  if (position === -1) return [...skills, next];
  return skills.map((known, index) => (index === position ? next : known));
}

/** Sidebar rows for the skills of one level: each skill, then its references one level deeper. */
export function skillItems(skills: readonly SkillOnBranch[], level: SkillLevel): PanelItem[] {
  return skills
    .filter((entry) => entry.skill.level === level)
    .flatMap((entry) => [
      { text: entry.skill.name, depth: 0, tone: entry.state === SkillState.Loaded ? ItemTone.Normal : ItemTone.Dim },
      ...entry.references.map((path) => ({ text: path, depth: 1, tone: ItemTone.Normal })),
    ]);
}

function withSkillLoaded(skill: Skill, current: SkillOnBranch | undefined): SkillOnBranch | undefined {
  if (current?.state === SkillState.Loaded) return undefined;
  return { skill, state: SkillState.Loaded, references: current?.references ?? [] };
}

function withReference(skill: Skill, path: string, current: SkillOnBranch | undefined): SkillOnBranch | undefined {
  if (current?.references.includes(path)) return undefined;
  return {
    skill,
    state: current?.state ?? SkillState.ReferencesOnly,
    references: [...(current?.references ?? []), path],
  };
}

function loadFromEntry(entry: BranchEntry, index: SkillIndex): SkillLoad | undefined {
  if (entry.type !== "custom") return undefined;
  if (entry.customType === LOADED_SKILL_ENTRY) {
    const name = (entry.data as Partial<LoadedSkillData> | undefined)?.name;
    return typeof name === "string" ? { kind: "skill", skill: skillNamed(index, name) } : undefined;
  }
  if (entry.customType === LOADED_SKILL_REFERENCE_ENTRY) {
    const data = entry.data as Partial<LoadedSkillReferenceData> | undefined;
    if (typeof data?.skill !== "string" || typeof data.path !== "string") return undefined;
    return { kind: "reference", skill: skillNamed(index, data.skill), path: data.path };
  }
  return undefined;
}

function skillNamed(index: SkillIndex, name: string): Skill {
  return findByName(index, name) ?? { name, level: "user" };
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

// Not decided by path: ~/.pi/agent/skills links into ~/config/pi/skills, so a path check would call user skills repo skills there.
function levelForScope(scope: string): SkillLevel {
  return scope === "project" ? "repo" : "user";
}

function findByName(index: SkillIndex, name: string): Skill | undefined {
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
