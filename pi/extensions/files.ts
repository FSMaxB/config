// Overrides Pi's built-in file tools with path-gated variants; read, write, and edit otherwise
// retain their stock behavior.
// Pi warns about each intentional built-in override once at startup.
import { lstat, unlink } from "node:fs/promises";
import type {
  ExtensionAPI,
  LsToolDetails,
  ReadToolInput,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  formatReadLineRange,
  keyText,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { TSchema } from "typebox";
import { errorCode } from "./lib/errors.ts";
import {
  activeSessionPathGrants,
  gatedTool,
  initPathPermissions,
  PathResolution,
} from "./lib/path-permissions.ts";
import { provideSessionGrants } from "./lib/session-grants.ts";
import { registerToolWithGuidelines } from "./lib/register-tool.ts";
import { buildSkillIndex, skillLoadForReadPath, skillReferenceLabel } from "./lib/skill-index.ts";
import type { SkillIndex, SkillReference } from "./lib/skill-index.ts";
import {
  createFindExecute,
  createGrepExecute,
  createLsExecute,
  findParameters,
  FIND_DEFAULT_LIMIT,
  GREP_DEFAULT_LIMIT,
  grepParameters,
  LS_DEFAULT_LIMIT,
  lsParameters,
  MAX_LINE_LENGTH,
} from "./lib/search-tools.ts";
import type { SearchDetails } from "./lib/search-tools.ts";

const ACCESS_NOTE =
  "Paths are checked against the read/write path rules: the repository and the memory, skill, plan and crit directories and the session's scratch directory ($TMPDIR in bash) are allowed by default, anything else prompts the user, and denied paths error.";

export default function (pi: ExtensionAPI): void {
  initPathPermissions(pi);
  provideSessionGrants(pi.events, activeSessionPathGrants);
  const cwd = process.cwd();

  registerToolWithGuidelines(
    pi,
    withNote(
      withSkillReferenceLabel(pi, gatedTool(createReadToolDefinition(cwd), "read")),
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

function withNote<TParameters extends TSchema, TDetails>(
  definition: ToolDefinition<TParameters, TDetails>,
  guideline: string,
): ToolDefinition<TParameters, TDetails> {
  return {
    ...definition,
    namespace: FILE_NAMESPACE,
    ...(["read", "ls", "find", "grep"].includes(definition.name)
      ? { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }
      : {}),
    description: `${definition.description}\n\n${ACCESS_NOTE}`,
    promptGuidelines: [guideline],
  };
}

type ReadDefinition = ReturnType<typeof createReadToolDefinition>;

/** Labels collapsed reads of a skill's other files the way pi labels reads of its SKILL.md. */
function withSkillReferenceLabel(pi: ExtensionAPI, definition: ReadDefinition): ReadDefinition {
  const stockRenderCall = definition.renderCall;
  if (stockRenderCall === undefined) return definition;
  let skillIndex: SkillIndex = new Map();
  // The skill set only changes on /reload, which emits session_start again.
  pi.on("session_start", () => {
    skillIndex = buildSkillIndex(pi.getCommands());
  });
  return {
    ...definition,
    renderCall(toolArguments, theme, context) {
      const load = context.expanded ? undefined : skillLoadForReadPath(skillIndex, toolArguments.path, context.cwd);
      if (load?.kind !== "reference") return stockRenderCall(toolArguments, theme, context);
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      text.setText(skillReferenceCall(load, toolArguments, theme));
      return text;
    },
  };
}

function skillReferenceCall(reference: SkillReference, toolArguments: ReadToolInput, theme: Theme): string {
  const range = formatReadLineRange(toolArguments.offset, toolArguments.limit);
  return (
    theme.fg("customMessageLabel", theme.bold("[skill reference]")) +
    " " +
    theme.fg("customMessageText", `${reference.skill.name} › ${skillReferenceLabel(reference.path)}`) +
    (range === "" ? "" : theme.fg("warning", range)) +
    theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`)
  );
}

function lsDefinition(cwd: string): ToolDefinition<typeof lsParameters, LsToolDetails | undefined> {
  const stockDefinition = createLsToolDefinition(cwd);
  return {
    ...stockDefinition,
    description:
      "List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. " +
      `Includes dotfiles. Output is truncated to ${LS_DEFAULT_LIMIT} entries or 50KB (whichever is hit first). ` +
      'Use output="count" to return only the exact number of immediate entries, omitting names and ignoring limit.',
    parameters: lsParameters,
    execute: createLsExecute((toolCallId, parameters, signal, onUpdate, context) =>
      stockDefinition.execute(toolCallId, parameters, signal, onUpdate, context),
    ),
  };
}

function findDefinition(cwd: string): ToolDefinition<typeof findParameters, SearchDetails | undefined> {
  return {
    ...createFindToolDefinition(cwd),
    description:
      "Search for files by glob pattern. Results are grouped by directory relative to the search " +
      "directory: an unindented 'dir/' line ('./' for the top level), then indented basenames. " +
      `Respects .gitignore. Output is truncated to ${FIND_DEFAULT_LIMIT} results or 50KB (whichever is hit first). ` +
      "Pass type ('file', 'directory' or 'symlink') to restrict what kind of entries are returned (like find -type). " +
      'Use output="count" to return only the exact number of matching entries, omitting paths and ignoring limit.',
    parameters: findParameters,
    execute: createFindExecute(),
  };
}

function grepDefinition(cwd: string): ToolDefinition<typeof grepParameters, SearchDetails | undefined> {
  return {
    ...createGrepToolDefinition(cwd),
    description:
      "Search file contents for a pattern. Matches are grouped by file: an unindented path line, " +
      "then indented 'line: text' rows for that file (context rows use 'line- text'). Respects .gitignore. " +
      `Output is truncated to ${GREP_DEFAULT_LIMIT} matches or 50KB (whichever is hit first). Long lines are truncated to ${MAX_LINE_LENGTH} chars. ` +
      "Set filesOnly to return only the paths of files containing matches (like grep -l); limit then counts files and context is ignored. " +
      'Use output="count" to return only the exact number of matches (or files with matches), omitting lines and ignoring limit.',
    parameters: grepParameters,
    execute: createGrepExecute(),
  };
}

const deleteParameters = Type.Object({
  path: Type.String({ description: "File to delete" }),
});

function deleteDefinition(): ToolDefinition<typeof deleteParameters, { path: string }> {
  return {
    name: "delete",
    label: "Delete",
    description:
      "Delete a single file. Directories are not removed; use bash for those. " +
      "When deleting a memory file, also drop its line from MEMORY.md.",
    promptSnippet: "Delete a file",
    parameters: deleteParameters,
    async execute(_toolCallId, parameters) {
      const { path } = parameters;
      const stats = await lstat(path).catch((error: unknown) => {
        if (errorCode(error) === "ENOENT") {
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

const FILE_NAMESPACE = { name: "files", description: "Read, search, and modify files through path permissions." };
