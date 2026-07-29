import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { contains, expandHome, skillRoots } from "./lib/repo.ts";

export default function (pi: ExtensionAPI) {
  const definition = createReadToolDefinition(process.cwd());

  pi.registerTool({
    ...definition,
    name: "load_skill",
    label: "Load skill",
    description:
      "Read a file from the skill directories: project-level .agents/skills and .pi/skills, then the global agent, ~/.agents and ~/.claude skill roots. " +
      "Pass the absolute path from a skill listing, or a path relative to a skill root like 'tuicr/SKILL.md'. " +
      "Also use it for the other files a skill references. Supports the same offset/limit paging as repo_read.",
    promptGuidelines: [
      "Use load_skill to read SKILL.md files and the files they reference, instead of repo_read or bash.",
    ],
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const path = resolveSkillPath(params.path);
      return await definition.execute(
        toolCallId,
        { ...params, path },
        signal,
        onUpdate,
        ctx,
      );
    },
  });
}

// The skill roots are trusted as installed, so unlike repo_read this never prompts:
// a skill symlinked into a root (as install.sh does for tuicr) is deliberate, and
// following the link must not trip the outside-the-repo check.
function resolveSkillPath(path: string): string {
  const roots = [...skillRoots()];
  const expanded = expandHome(path);

  if (isAbsolute(expanded)) {
    const absolute = resolve(expanded);
    if (roots.some((root) => contains(root, absolute))) return absolute;
    throw new Error(
      `${path} is not inside a skill directory. Use repo_read for ordinary files.`,
    );
  }

  for (const root of roots) {
    const candidate = join(root, expanded);
    if (contains(root, candidate) && existsSync(candidate)) return candidate;
  }
  throw new Error(
    `${path} not found under any skill root:\n${roots
      .map((root) => `  ${root}`)
      .join("\n")}`,
  );
}
