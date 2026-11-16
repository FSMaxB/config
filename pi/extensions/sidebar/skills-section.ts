import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SectionChanged, SidebarSection } from "./section.ts";
import {
  buildSkillIndex,
  LOADED_SKILL_ENTRY,
  type LoadedSkill,
  loadedSkillsOnBranch,
  type SkillIndex,
  type SkillLevel,
  skillForReadPath,
  skillFromUserContent,
} from "./skills.ts";

const TITLES: Record<SkillLevel, string> = { repo: "Repo skills", user: "User skills" };

export function createSkillsSections(pi: ExtensionAPI, changed: SectionChanged): SidebarSection[] {
  let index: SkillIndex = new Map();
  let loaded: LoadedSkill[] = [];

  // Returning a value from a tool_result handler would replace the tool result, so these return nothing.
  pi.on("tool_result", async (event, context) => {
    if (event.toolName !== "read" || event.isError) return;
    record(skillForReadPath(index, event.input.path, context.cwd), context);
  });

  pi.on("message_start", async (event, context) => {
    if (event.message.role !== "user") return;
    record(skillFromUserContent(index, event.message.content), context);
  });

  // `restore` runs per section in array order, so the repo section owns the rebuild of the shared state.
  return [
    {
      title: TITLES.repo,
      // The skill set only changes on /reload, which restarts extensions, so rebuilding here is enough.
      restore: (context) => {
        rebuild(context);
      },
      items: () => namesAt("repo"),
    },
    { title: TITLES.user, restore: () => {}, items: () => namesAt("user") },
  ];

  function rebuild(context: ExtensionContext): void {
    index = buildSkillIndex(pi.getCommands());
    loaded = loadedSkillsOnBranch(context.sessionManager.getBranch(), index);
  }

  function namesAt(level: SkillLevel): string[] {
    return loaded.filter((skill) => skill.level === level).map((skill) => skill.name);
  }

  function record(skill: LoadedSkill | undefined, context: ExtensionContext): void {
    if (skill === undefined || loaded.some((known) => known.name === skill.name)) return;
    loaded = [...loaded, skill];
    pi.appendEntry(LOADED_SKILL_ENTRY, { name: skill.name });
    changed(context);
  }
}
