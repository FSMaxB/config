// Overrides Pi's built-in file tools with path-gated variants; read, write, and edit otherwise
// retain their stock behavior.
// Pi warns about each intentional built-in override once at startup.
import { lstat, unlink } from "node:fs/promises";
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
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  gatedTool,
  initPathPermissions,
  PathResolution,
} from "./lib/path-permissions.ts";
import { registerToolWithGuidelines } from "./lib/register-tool.ts";
import {
  createFindExecute,
  createGrepExecute,
  createLsExecute,
} from "./lib/search-tools.ts";

const ACCESS_NOTE =
  "Paths are checked against the read/write path rules: the repository and the memory, skill, plan and crit directories are allowed by default, anything else prompts the user, and denied paths error.";

export default function (pi: ExtensionAPI) {
  initPathPermissions(pi);
  const cwd = process.cwd();

  registerToolWithGuidelines(
    pi,
    withNote(
      gatedTool(createReadToolDefinition(cwd), "read"),
      "Use read to examine files instead of cat or sed.",
    ),
  );
  registerToolWithGuidelines(
    pi,
    withNote(
      gatedTool(createWriteToolDefinition(cwd), "write"),
      "Use write only for new files or complete rewrites.",
    ),
  );
  registerToolWithGuidelines(
    pi,
    withNote(
      gatedTool(createEditToolDefinition(cwd), "write"),
      "Use edit to change an existing file instead of rewriting it wholesale.",
    ),
  );
  registerToolWithGuidelines(
    pi,
    withNote(
      gatedTool(lsDefinition(cwd), "read", PathResolution.Follow, "children"),
      'Before a potentially broad ls operation, use output="count" to measure it; do not shell out to ls plus wc -l. Pass limit to change the returned entry cap in results mode.',
    ),
  );
  registerToolWithGuidelines(
    pi,
    withNote(
      gatedTool(
        findDefinition(cwd),
        "read",
        PathResolution.Follow,
        "recursive",
      ),
      'Before a potentially broad find operation, use output="count" to measure it; do not shell out to find or fd plus wc -l.',
    ),
  );
  registerToolWithGuidelines(
    pi,
    withNote(
      gatedTool(
        grepDefinition(cwd),
        "read",
        PathResolution.Follow,
        "recursive",
      ),
      'Before a potentially broad grep operation, use output="count" to measure it; do not shell out to grep or rg plus wc -l.',
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

function lsDefinition(cwd: string): ToolDefinition<any, any, any> {
  const stockDefinition = createLsToolDefinition(cwd) as ToolDefinition<
    any,
    any,
    any
  >;
  return {
    ...stockDefinition,
    description:
      "List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. " +
      "Includes dotfiles. Output is truncated to 500 entries or 50KB (whichever is hit first). " +
      'Use output="count" to return only the exact number of immediate entries, omitting names and ignoring limit.',
    parameters: lsParameters,
    execute: createLsExecute(cwd, stockDefinition.execute),
  };
}

function findDefinition(cwd: string): ToolDefinition<any, any, any> {
  return {
    ...(createFindToolDefinition(cwd) as ToolDefinition<any, any, any>),
    description:
      "Search for files by glob pattern. Results are grouped by directory relative to the search " +
      "directory: an unindented 'dir/' line ('./' for the top level), then indented basenames. " +
      "Respects .gitignore. Output is truncated to 1000 results or 50KB (whichever is hit first). " +
      "Pass type ('file', 'directory' or 'symlink') to restrict what kind of entries are returned (like find -type). " +
      'Use output="count" to return only the exact number of matching entries, omitting paths and ignoring limit.',
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
      "Set filesOnly to return only the paths of files containing matches (like grep -l); limit then counts files and context is ignored. " +
      'Use output="count" to return only the exact number of matches (or files with matches), omitting lines and ignoring limit.',
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

const outputParameter = Type.Optional(
  StringEnum(["results", "count"] as const, {
    description:
      "Return matching results, or only their exact count (default: results)",
  }),
);

const lsParameters = Type.Object({
  path: Type.Optional(
    Type.String({
      description: "Directory to list (default: current directory)",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description:
        "Maximum number of entries to return (default: 500); ignored when output is count",
    }),
  ),
  output: outputParameter,
});

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
    Type.Number({
      description:
        "Maximum number of results to return (default: 1000); ignored when output is count",
    }),
  ),
  output: outputParameter,
  type: Type.Optional(
    Type.Union(
      [
        Type.Literal("file"),
        Type.Literal("directory"),
        Type.Literal("symlink"),
      ],
      {
        description: "Restrict results to this entry type (default: all types)",
      },
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
      description:
        "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'",
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
      description:
        "Maximum number of matches to return (default: 100); ignored when output is count",
    }),
  ),
  filesOnly: Type.Optional(
    Type.Boolean({
      description:
        "Return only the paths of files containing matches, like grep -l; limit counts files and context is ignored (default: false)",
    }),
  ),
  output: outputParameter,
});
