import { ItemTone } from "./panel.ts";
import type { PanelItem } from "./panel.ts";
import type { BranchEntry } from "./section.ts";
import { skillReferenceLabel } from "../lib/skill-index.ts";
import type { Skill, SkillIndex, SkillLevel, SkillLoad } from "../lib/skill-index.ts";
import { isRecord, stringProperty } from "../lib/untyped.ts";

export const LOADED_SKILL_ENTRY = "loaded-skill";
export const LOADED_SKILL_REFERENCE_ENTRY = "loaded-skill-reference";

export interface LoadedSkillData { name: string }
/** `path` is relative to the skill's directory. */
export interface LoadedSkillReferenceData { skill: string; path: string }

/** Whether the skill's own SKILL.md was loaded, or only some of its other files. */
export const SkillState = { Loaded: "loaded", ReferencesOnly: "references-only" } as const;
export type SkillState = (typeof SkillState)[keyof typeof SkillState];

export interface SkillOnBranch { skill: Skill; state: SkillState; references: readonly string[] }

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

export function skillItems(skills: readonly SkillOnBranch[], level: SkillLevel): PanelItem[] {
  return skills
    .filter((entry) => entry.skill.level === level)
    .flatMap((entry) => [
      { text: entry.skill.name, depth: 0, tone: entry.state === SkillState.Loaded ? ItemTone.Normal : ItemTone.Dim },
      ...entry.references.map((path) => ({ text: skillReferenceLabel(path), depth: 1, tone: ItemTone.Normal })),
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
    const name = isRecord(entry.data) ? stringProperty(entry.data, "name") : undefined;
    return name === undefined ? undefined : { kind: "skill", skill: skillNamed(index, name) };
  }
  if (entry.customType === LOADED_SKILL_REFERENCE_ENTRY) {
    const skill = isRecord(entry.data) ? stringProperty(entry.data, "skill") : undefined;
    const path = isRecord(entry.data) ? stringProperty(entry.data, "path") : undefined;
    if (skill === undefined || path === undefined) return undefined;
    return { kind: "reference", skill: skillNamed(index, skill), path };
  }
  return undefined;
}

function skillNamed(index: SkillIndex, name: string): Skill {
  return findByName(index, name) ?? { name, level: "user" };
}

function findByName(index: SkillIndex, name: string): Skill | undefined {
  return [...index.values()].find((skill) => skill.name === name);
}

function firstText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const block = content.find((item) => item?.type === "text" && typeof item.text === "string");
  return block?.text ?? "";
}
