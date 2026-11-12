import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SectionChanged, SidebarSection } from "./section.ts";
import {
  buildSkillIndex,
  LOADED_SKILL_ENTRY,
  loadedSkillsOnBranch,
  type SkillIndex,
  skillForReadPath,
  skillFromUserContent,
} from "./skills.ts";

export function createSkillsSection(pi: ExtensionAPI, changed: SectionChanged): SidebarSection {
  let index: SkillIndex = new Map();
  let names: string[] = [];

  // Returning a value from a tool_result handler would replace the tool result, so these return nothing.
  pi.on("tool_result", async (event, context) => {
    if (event.toolName !== "read" || event.isError) return;
    record(skillForReadPath(index, event.input.path, context.cwd), context);
  });

  pi.on("message_start", async (event, context) => {
    if (event.message.role !== "user") return;
    record(skillFromUserContent(index, event.message.content), context);
  });

  return {
    title: "Skills",
    // The skill set only changes on /reload, which restarts extensions, so rebuilding here is enough.
    restore: (context) => {
      index = buildSkillIndex(pi.getCommands());
      names = loadedSkillsOnBranch(context.sessionManager.getBranch());
    },
    items: () => names,
  };

  function record(name: string | undefined, context: ExtensionContext): void {
    if (name === undefined || names.includes(name)) return;
    names = [...names, name];
    pi.appendEntry(LOADED_SKILL_ENTRY, { name });
    changed(context);
  }
}
