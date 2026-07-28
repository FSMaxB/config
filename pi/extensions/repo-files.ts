import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type AccessMode, ensureAccessible } from "./lib/repo.ts";

const SCOPE_NOTE =
  "Confined to the current repository: paths outside it need the user's approval, and .git/.jj are read-only.";

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();

  pi.registerTool(
    scoped(createReadToolDefinition(cwd), {
      name: "repo_read",
      label: "Repo read",
      mode: "read",
      guideline: "Use repo_read to examine files instead of cat or sed.",
    }),
  );

  pi.registerTool(
    scoped(createLsToolDefinition(cwd), {
      name: "repo_ls",
      label: "Repo ls",
      mode: "read",
      guideline:
        "Use repo_ls to list a directory instead of shelling out to ls.",
    }),
  );

  pi.registerTool(
    scoped(createFindToolDefinition(cwd), {
      name: "repo_find",
      label: "Repo find",
      mode: "read",
      guideline:
        "Use repo_find to locate files by glob instead of shelling out to find or fd.",
    }),
  );

  pi.registerTool(
    scoped(createGrepToolDefinition(cwd), {
      name: "repo_grep",
      label: "Repo grep",
      mode: "read",
      guideline:
        "Use repo_grep to search file contents instead of shelling out to grep or rg.",
    }),
  );

  pi.registerTool(
    scoped(createWriteToolDefinition(cwd), {
      name: "repo_write",
      label: "Repo write",
      mode: "write",
      guideline:
        "Use repo_write to create a file instead of shelling out to a heredoc.",
    }),
  );

  pi.registerTool(
    scoped(createEditToolDefinition(cwd), {
      name: "repo_edit",
      label: "Repo edit",
      mode: "write",
      guideline:
        "Use repo_edit to change an existing file instead of rewriting it wholesale.",
    }),
  );
}

interface ScopeOptions {
  name: string;
  label: string;
  mode: AccessMode;
  guideline: string;
}

// Wraps a built-in tool definition under a new name. Spreading keeps the built-in renderers,
// so the UI (syntax highlighting, edit diffs, truncation notices) is unchanged, and keeps the
// result shape the session logic expects. Only execute() is intercepted.
function scoped(
  definition: ToolDefinition<any, any, any>,
  options: ScopeOptions,
): ToolDefinition<any, any, any> {
  const { name, label, mode, guideline } = options;
  return {
    ...definition,
    name,
    label,
    description: `${definition.description}\n\n${SCOPE_NOTE}`,
    promptGuidelines: [guideline],
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      await ensureAccessible(params.path ?? process.cwd(), mode, ctx);
      return await definition.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
        ctx,
      );
    },
  };
}
