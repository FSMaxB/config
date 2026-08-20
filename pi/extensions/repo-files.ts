import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { ensureAccessible } from "./lib/repo.ts";
import { scopedTool } from "./lib/scoped-tool.ts";

const SCOPE_NOTE =
  "Confined to the current repository: paths outside it need the user's approval, and .git/.jj are read-only.";

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();

  pi.registerTool(
    scopedTool(createReadToolDefinition(cwd), {
      name: "repo_read",
      label: "Repo read",
      guideline: "Use repo_read to examine files instead of cat or sed.",
      scopeNote: SCOPE_NOTE,
      ensurePath: (params, ctx) => ensureAccessible(params.path ?? cwd, "read", ctx),
    }),
  );

  pi.registerTool(
    scopedTool(createLsToolDefinition(cwd), {
      name: "repo_ls",
      label: "Repo ls",
      guideline:
        "Use repo_ls to list a directory instead of shelling out to ls.",
      descriptionNote: "Pass limit to change the entry cap.",
      scopeNote: SCOPE_NOTE,
      ensurePath: (params, ctx) => ensureAccessible(params.path ?? cwd, "read", ctx),
    }),
  );

  pi.registerTool(
    scopedTool(createFindToolDefinition(cwd), {
      name: "repo_find",
      label: "Repo find",
      guideline:
        "Use repo_find to locate files by glob instead of shelling out to find or fd.",
      scopeNote: SCOPE_NOTE,
      ensurePath: (params, ctx) => ensureAccessible(params.path ?? cwd, "read", ctx),
    }),
  );

  pi.registerTool(
    scopedTool(createGrepToolDefinition(cwd), {
      name: "repo_grep",
      label: "Repo grep",
      guideline:
        "Use repo_grep to search file contents instead of shelling out to grep or rg.",
      scopeNote: SCOPE_NOTE,
      ensurePath: (params, ctx) => ensureAccessible(params.path ?? cwd, "read", ctx),
    }),
  );

  pi.registerTool(
    scopedTool(createWriteToolDefinition(cwd), {
      name: "repo_write",
      label: "Repo write",
      guideline:
        "Use repo_write to create a file instead of shelling out to a heredoc.",
      scopeNote: SCOPE_NOTE,
      ensurePath: (params, ctx) => ensureAccessible(params.path ?? cwd, "write", ctx),
    }),
  );

  pi.registerTool(
    scopedTool(createEditToolDefinition(cwd), {
      name: "repo_edit",
      label: "Repo edit",
      guideline:
        "Use repo_edit to change an existing file instead of rewriting it wholesale.",
      scopeNote: SCOPE_NOTE,
      ensurePath: (params, ctx) => ensureAccessible(params.path ?? cwd, "write", ctx),
    }),
  );
}
