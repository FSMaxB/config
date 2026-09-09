// Pi-facing tool definitions for the hashline read/write/edit tools. Kept apart from
// lib/hashline.ts so the pure patch core stays free of pi and node:fs imports.
import { open, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  EditToolDetails,
  EditToolInput,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
  detectSupportedImageMimeTypeFromFile,
  generateDiffString,
  generateUnifiedPatch,
  truncateHead,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  applyOps,
  findSnapshot,
  parsePatch,
  recordSnapshot,
  remapOps,
  renderNumbered,
  renderRegions,
  snapshotOf,
} from "./hashline.ts";

const READ_DESCRIPTION =
  "Read file contents. Prints a header '[path#TAG]' followed by numbered lines 'N:text'. " +
  "TAG is a short content hash; both the header and the line numbers are what the edit tool's " +
  "patch needs, so copy them from the most recent read instead of guessing. offset/limit page " +
  "through the file the same way as before. Pass raw: true to get the file's exact bytes back " +
  "with no header and no line numbers, for example to quote text verbatim elsewhere.";

const WRITE_DESCRIPTION =
  "Create or overwrite files. The result includes a '[path#TAG]' header for the content just " +
  "written, so an edit can follow immediately without a separate read.";

const EDIT_DESCRIPTION =
  "Change an existing file with a line-anchored patch instead of a literal search-and-replace. " +
  "The patch is one string with this grammar:\n\n" +
  "[path#TAG]           header: copy this verbatim from your last read of the file; never invent a tag\n" +
  "PUT 12.=14:          replace lines 12-14 with the body rows that follow\n" +
  "+  const x = 1;\n" +
  "+\n" +
  "PUT <1:              insert before line 1\n" +
  "PUT >$:              insert after the last line ('$' always means the last line)\n" +
  "CUT 30.=32           delete lines 30-32 (no body rows)\n\n" +
  "Body rows start with '+'; a bare '+' is a blank line. There are no '-old' rows: the range in " +
  "the op already says what is being replaced or removed, so the body only ever lists the new " +
  "content. Line numbers always name the lines of the snapshot the header's tag identifies, so " +
  "ops in one patch never renumber each other and must not overlap. A patch may contain several " +
  "ops. The result prints the new tag and the changed lines, so either chain further edits from " +
  "that or read the file again. A stale tag is automatically recovered when the lines it names " +
  "are unchanged, and rejected (asking you to re-read) when they moved ambiguously or changed.";

export function createHashlineReadToolDefinition(
  cwd: string,
): ToolDefinition<any, any, any> {
  const builtin = createReadToolDefinition(cwd);
  if (process.env.PI_HASHLINE === "0") return builtin;

  const parameters = Type.Object({
    path: Type.String(),
    offset: Type.Optional(Type.Number()),
    limit: Type.Optional(Type.Number()),
    raw: Type.Optional(Type.Boolean()),
  });

  return defineTool({
    ...builtin,
    description: READ_DESCRIPTION,
    parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const absolute = resolve(ctx?.cwd || cwd, params.path);
      if (params.raw || (await isNonText(absolute))) {
        return await builtin.execute(
          toolCallId,
          { path: params.path, offset: params.offset, limit: params.limit },
          signal,
          onUpdate,
          ctx,
        );
      }

      const content = await readFile(absolute, "utf8");
      const snapshot = recordSnapshot(absolute, content);
      const offset = Math.max(1, params.offset ?? 1);
      const window = snapshot.lines.slice(
        offset - 1,
        params.limit === undefined ? undefined : offset - 1 + params.limit,
      );
      const truncation = truncateHead(renderNumbered(window, offset));
      const shown = offset - 1 + truncation.outputLines;
      const remaining = snapshot.lines.length - shown;

      const text = [
        `[${params.path}#${snapshot.tag}]`,
        truncation.content,
        remaining > 0
          ? `[${remaining} more lines in file. Use offset=${shown + 1} to continue.]`
          : undefined,
      ]
        .filter((part) => part !== undefined)
        .join("\n");

      return { content: [{ type: "text", text }], details: { truncation } };
    },
  });
}

async function isNonText(absolutePath: string): Promise<boolean> {
  if (await detectSupportedImageMimeTypeFromFile(absolutePath)) return true;
  try {
    const handle = await open(absolutePath, "r");
    try {
      const buffer = Buffer.alloc(8192);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).includes(0);
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

export function createHashlineWriteToolDefinition(
  cwd: string,
): ToolDefinition<any, any, any> {
  const builtin = createWriteToolDefinition(cwd);
  if (process.env.PI_HASHLINE === "0") return builtin;

  return defineTool({
    ...builtin,
    description: WRITE_DESCRIPTION,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const absolute = resolve(ctx?.cwd || cwd, params.path);
      const result = await builtin.execute(toolCallId, params, signal, onUpdate, ctx);
      const snapshot = recordSnapshot(absolute, params.content);
      const written = result.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
      const text = `${written}\n\n[${params.path}#${snapshot.tag}]`;
      return { ...result, content: [{ type: "text", text }] };
    },
  });
}

export function createHashlineEditToolDefinition(
  cwd: string,
): ToolDefinition<any, any, any> {
  const builtin = createEditToolDefinition(cwd);
  if (process.env.PI_HASHLINE === "0") return builtin;

  const parameters = Type.Object({
    path: Type.String(),
    patch: Type.String(),
  });

  return defineTool({
    ...builtin,
    description: EDIT_DESCRIPTION,
    parameters,
    prepareArguments: undefined,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const absolute = resolve(ctx?.cwd || cwd, params.path);
      const parsed = parsePatch(params.patch);
      const patchAbsolute = resolve(ctx?.cwd || cwd, parsed.path);
      if (patchAbsolute !== absolute) {
        throw new Error(
          `The patch header names ${parsed.path}, but this edit call's path is ${params.path}. ` +
            "They must be the same file.",
        );
      }

      return await withFileMutationQueue(absolute, async () => {
        const content = await readFile(absolute, "utf8").catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new Error(
              `${params.path} does not exist. hashline edit only changes existing files; use write to create one.`,
            );
          }
          throw error;
        });
        const current = snapshotOf(content);
        const ops =
          parsed.tag === current.tag
            ? parsed.ops
            : remapOps(parsed.ops, requireSnapshot(absolute, parsed.tag, params.path), current);
        const { content: newContent, changed } = applyOps(current, ops);
        await writeFile(absolute, newContent);
        const next = recordSnapshot(absolute, newContent);
        const { diff, firstChangedLine } = generateDiffString(content, newContent);

        const text = [`[${params.path}#${next.tag}]`, renderRegions(next, changed)].join("\n");

        const hashlineArgs: EditToolInput = {
          path: params.path,
          edits: [{ oldText: content, newText: newContent }],
        };
        const details: EditToolDetails & { hashlineArgs: EditToolInput } = {
          diff,
          patch: generateUnifiedPatch(params.path, content, newContent),
          firstChangedLine,
          hashlineArgs,
        };

        return { content: [{ type: "text", text }], details };
      });
    },
    renderCall(args, theme: Theme) {
      const patch = typeof args.patch === "string" ? args.patch : "";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("edit "))}${theme.fg("dim", firstOpSummary(patch))}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme, context) {
      const details = result.details as (EditToolDetails & { hashlineArgs?: EditToolInput }) | undefined;
      return builtin.renderResult!(
        result,
        options,
        theme,
        { ...context, args: details?.hashlineArgs ?? context.args } as any,
      );
    },
  });
}

function requireSnapshot(absolutePath: string, tag: string, displayPath: string) {
  const snapshot = findSnapshot(absolutePath, tag);
  if (snapshot === undefined) {
    throw new Error(
      `[${displayPath}#${tag}] is not a tag this session has seen. Read ${displayPath} again and re-anchor the patch.`,
    );
  }
  return snapshot;
}

// renderCall receives partially streamed, unvalidated arguments, so this must tolerate a
// missing or half-written patch (see pi/extensions/question.ts's coerceOption comment).
function firstOpSummary(patch: string): string {
  const match = patch.match(/^(PUT|CUT)\b.*$/m);
  return match ? match[0] : "…";
}
