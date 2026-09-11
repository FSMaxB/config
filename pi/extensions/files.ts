// Overrides the built-in read/write/edit/ls/find/grep tools with path-gated variants. The
// read/write/edit tools use hashlines (see lib/hashline.ts and lib/hashline-tools.ts), unless
// PI_HASHLINE=0 selects their stock implementations. Path checks remain enabled either way.
// Pi warns about each intentional built-in override once at startup.
import { lstat, unlink } from "node:fs/promises";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createHashlineEditToolDefinition,
  createHashlineReadToolDefinition,
  createHashlineWriteToolDefinition,
} from "./lib/hashline-tools.ts";
import {
  gatedTool,
  initPathPermissions,
  PathResolution,
} from "./lib/path-permissions.ts";
import { registerToolWithGuidelines } from "./lib/register-tool.ts";
import { createFindExecute, createGrepExecute } from "./lib/search-tools.ts";

const ACCESS_NOTE =
  "Paths are checked against the read/write path rules: the repository and the memory, skill, plan and crit directories are allowed by default, anything else prompts the user, and denied paths error.";

export default function (pi: ExtensionAPI) {
  initPathPermissions(pi);
  const cwd = process.cwd();

  registerToolWithGuidelines(
    pi,
    withNote(
      gatedTool(createHashlineReadToolDefinition(cwd), "read"),
      "Use read to examine files instead of cat or sed.",
    ),
  );
  registerToolWithGuidelines(
    pi,
    withNote(
      gatedTool(createHashlineWriteToolDefinition(cwd), "write"),
      "Use write only for new files or complete rewrites.",
    ),
  );
  registerToolWithGuidelines(
    pi,
    withNote(
      gatedTool(createHashlineEditToolDefinition(cwd), "write"),
      "Use edit to change an existing file instead of rewriting it wholesale.",
    ),
  );
  registerToolWithGuidelines(
    pi,
    withNote(
      gatedTool(createLsToolDefinition(cwd), "read"),
      "Use ls to list a directory instead of shelling out to ls. Pass limit to change the entry cap.",
    ),
  );
  registerToolWithGuidelines(
    pi,
    withNote(
      gatedTool(findDefinition(cwd), "read"),
      "Use find to locate files by glob instead of shelling out to find or fd.",
    ),
  );
  registerToolWithGuidelines(
    pi,
    withNote(
      gatedTool(grepDefinition(cwd), "read"),
      "Use grep to search file contents instead of shelling out to grep or rg.",
    ),
  );
  registerToolWithGuidelines(
    pi,
    withNote(
      gatedTool(
        deleteDefinition(),
        "write",
        PathResolution.PreserveFinalSymlink,
      ),
      "Use delete to remove a file instead of shelling out to rm.",
    ),
  );
}

function withNote(
  definition: ToolDefinition<any, any, any>,
  guideline: string,
): ToolDefinition<any, any, any> {
  return {
    ...definition,
    description: `${definition.description}\n\n${ACCESS_NOTE}`,
    promptGuidelines: [guideline],
  };
}

function findDefinition(cwd: string): ToolDefinition<any, any, any> {
  return {
    ...(createFindToolDefinition(cwd) as ToolDefinition<any, any, any>),
    description:
      "Search for files by glob pattern. Results are grouped by directory relative to the search " +
      "directory: an unindented 'dir/' line ('./' for the top level), then indented basenames. " +
      "Respects .gitignore. Output is truncated to 1000 results or 50KB (whichever is hit first). " +
      "Pass type ('file', 'directory' or 'symlink') to restrict what kind of entries are returned (like find -type).",
    parameters: findParameters,
    execute: createFindExecute(cwd),
  };
}

function grepDefinition(cwd: string): ToolDefinition<any, any, any> {
  return {
    ...(createGrepToolDefinition(cwd) as ToolDefinition<any, any, any>),
    description:
      "Search file contents for a pattern. Matches are grouped by file: an unindented path line, " +
      "then indented 'line: text' rows for that file (context rows use 'line- text'). Respects .gitignore. " +
      "Output is truncated to 100 matches or 50KB (whichever is hit first). Long lines are truncated to 500 chars. " +
      "Set filesOnly to return only the paths of files containing matches (like grep -l); limit then counts files and context is ignored.",
    parameters: grepParameters,
    execute: createGrepExecute(cwd),
  };
}

function deleteDefinition(): ToolDefinition<any, any, any> {
  return {
    name: "delete",
    label: "Delete",
    description:
      "Delete a single file. Directories are not removed; use bash for those. " +
      "When deleting a memory file, also drop its line from MEMORY.md.",
    promptSnippet: "Delete a file",
    parameters: Type.Object({
      path: Type.String({ description: "File to delete" }),
    }),
    async execute(_toolCallId, params) {
      const { path } = params as { path: string };
      const stats = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          throw new Error(`There is no file at ${path}.`);
        }
        throw error;
      });
      if (stats.isDirectory()) {
        throw new Error(
          `${path} is a directory. delete only removes files; use bash to remove directories.`,
        );
      }
      await unlink(path);
      return {
        content: [{ type: "text", text: `Deleted ${path}.` }],
        details: { path },
      };
    },
  };
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
      description: "Treat pattern as literal string instead of regex (default: false)",
    }),
  ),
  context: Type.Optional(
    Type.Number({
      description: "Number of lines to show before and after each match (default: 0)",
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
