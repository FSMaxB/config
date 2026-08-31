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
import { Type } from "typebox";
import { registerToolWithGuidelines } from "./lib/register-tool.ts";
import { ensureAccessible } from "./lib/repo.ts";
import { scopedTool } from "./lib/scoped-tool.ts";
import { createFindExecute, createGrepExecute } from "./lib/search-tools.ts";

const SCOPE_NOTE =
  "Confined to the current repository: paths outside it need the user's approval, and .git/.jj are read-only.";

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();

  registerToolWithGuidelines(
    pi,
    scopedTool(createReadToolDefinition(cwd), {
      name: "repo_read",
      label: "Repo read",
      guideline: "Use repo_read to examine files instead of cat or sed.",
      scopeNote: SCOPE_NOTE,
      ensurePath: (params, ctx) => ensureAccessible(params.path ?? cwd, "read", ctx),
    }),
  );

  registerToolWithGuidelines(
    pi,
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

  registerToolWithGuidelines(
    pi,
    scopedTool(
      {
        ...(createFindToolDefinition(cwd) as ToolDefinition<any, any, any>),
        parameters: findParameters,
        execute: createFindExecute(cwd),
      },
      {
        name: "repo_find",
        label: "Repo find",
        guideline:
          "Use repo_find to locate files by glob instead of shelling out to find or fd.",
        descriptionNote:
          "Pass type ('file', 'directory' or 'symlink') to restrict what kind of entries are returned (like find -type).",
        scopeNote: SCOPE_NOTE,
        ensurePath: (params, ctx) => ensureAccessible(params.path ?? cwd, "read", ctx),
      },
    ),
  );

  registerToolWithGuidelines(
    pi,
    scopedTool(
      {
        ...(createGrepToolDefinition(cwd) as ToolDefinition<any, any, any>),
        parameters: grepParameters,
        execute: createGrepExecute(cwd),
      },
      {
        name: "repo_grep",
        label: "Repo grep",
        guideline:
          "Use repo_grep to search file contents instead of shelling out to grep or rg.",
        descriptionNote:
          "Set filesOnly to return only the paths of files containing matches (like grep -l); limit then counts files and context is ignored.",
        scopeNote: SCOPE_NOTE,
        ensurePath: (params, ctx) => ensureAccessible(params.path ?? cwd, "read", ctx),
      },
    ),
  );

  registerToolWithGuidelines(
    pi,
    scopedTool(createWriteToolDefinition(cwd), {
      name: "repo_write",
      label: "Repo write",
      guideline:
        "Use repo_write to create a file instead of shelling out to a heredoc.",
      scopeNote: SCOPE_NOTE,
      ensurePath: (params, ctx) => ensureAccessible(params.path ?? cwd, "write", ctx),
    }),
  );

  registerToolWithGuidelines(
    pi,
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

const findParameters = Type.Object({
  pattern: Type.String({
    description:
      "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
  }),
  path: Type.Optional(
    Type.String({
      description: "Directory to search in (default: current directory)",
    }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Maximum number of results (default: 1000)" }),
  ),
  type: Type.Optional(
    Type.Union(
      [
        Type.Literal("file"),
        Type.Literal("directory"),
        Type.Literal("symlink"),
      ],
      { description: "Restrict results to this entry type (default: all types)" },
    ),
  ),
});

const grepParameters = Type.Object({
  pattern: Type.String({
    description: "Search pattern (regex or literal string)",
  }),
  path: Type.Optional(
    Type.String({
      description: "Directory or file to search (default: current directory)",
    }),
  ),
  glob: Type.Optional(
    Type.String({
      description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'",
    }),
  ),
  ignoreCase: Type.Optional(
    Type.Boolean({ description: "Case-insensitive search (default: false)" }),
  ),
  literal: Type.Optional(
    Type.Boolean({
      description:
        "Treat pattern as literal string instead of regex (default: false)",
    }),
  ),
  context: Type.Optional(
    Type.Number({
      description:
        "Number of lines to show before and after each match (default: 0)",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum number of matches to return (default: 100)",
    }),
  ),
  filesOnly: Type.Optional(
    Type.Boolean({
      description:
        "Return only the paths of files containing matches, like grep -l; limit counts files and context is ignored (default: false)",
    }),
  ),
});
