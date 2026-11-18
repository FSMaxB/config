import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SectionChanged, SidebarSection } from "./section.ts";
import { buildSkillIndex, skillLoadForReadPath } from "../lib/skill-index.ts";
import type { SkillIndex, SkillLevel, SkillLoad } from "../lib/skill-index.ts";
import {
  applySkillLoad,
  LOADED_SKILL_ENTRY,
  LOADED_SKILL_REFERENCE_ENTRY,
  skillItems,
  skillLoadFromUserContent,
  skillsOnBranch,
} from "./skills.ts";
import type { LoadedSkillData, LoadedSkillReferenceData, SkillOnBranch } from "./skills.ts";

const TITLES: Record<SkillLevel, string> = { repo: "Repo skills", user: "User skills" };

export function createSkillsSections(pi: ExtensionAPI, changed: SectionChanged): SidebarSection[] {
  let index: SkillIndex = new Map();
  let skills: readonly SkillOnBranch[] = [];

  // Returning a value from a tool_result handler would replace the tool result, so these return nothing.
  pi.on("tool_result", async (event, context) => {
    if (event.toolName !== "read" || event.isError) return;
    record(skillLoadForReadPath(index, event.input.path, context.cwd), context);
  });

  pi.on("message_start", async (event, context) => {
    if (event.message.role !== "user") return;
    record(skillLoadFromUserContent(index, event.message.content), context);
  });

  // `restore` runs per section in array order, so the repo section owns the rebuild of the shared state.
  return [
    {
      title: TITLES.repo,
      // The skill set only changes on /reload, which restarts extensions, so rebuilding here is enough.
      restore: (context) => {
        rebuild(context);
      },
      items: () => skillItems(skills, "repo"),
    },
    { title: TITLES.user, restore: () => {}, items: () => skillItems(skills, "user") },
  ];

  function rebuild(context: ExtensionContext): void {
    index = buildSkillIndex(pi.getCommands());
    skills = skillsOnBranch(context.sessionManager.getBranch(), index);
  }

  function record(load: SkillLoad | undefined, context: ExtensionContext): void {
    if (load === undefined) return;
    const next = applySkillLoad(skills, load);
    if (next === undefined) return;
    skills = next;
    appendLoadEntry(load);
    changed(context);
  }

  function appendLoadEntry(load: SkillLoad): void {
    if (load.kind === "skill") {
      pi.appendEntry(LOADED_SKILL_ENTRY, { name: load.skill.name } satisfies LoadedSkillData);
      return;
    }
    pi.appendEntry(LOADED_SKILL_REFERENCE_ENTRY, {
      skill: load.skill.name,
      path: load.path,
    } satisfies LoadedSkillReferenceData);
  }
}
