import { unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  contains,
  memoryDirectory,
  resolveThroughSymlinks,
} from "./lib/repo.ts";

const SCOPE_NOTE =
  "Confined to the agent memory directory: relative paths (like MEMORY.md or some-fact.md) " +
  "are resolved against it, and nothing outside it can be touched.";

export default function (pi: ExtensionAPI) {
  const memoryRoot = memoryDirectory();

  pi.registerTool(
    scoped(createReadToolDefinition(memoryRoot), {
      name: "memory_read",
      label: "Memory read",
      guideline:
        "Use memory_read to read memory files instead of the generic read tools.",
    }),
  );

  pi.registerTool(
    scoped(createLsToolDefinition(memoryRoot), {
      name: "memory_ls",
      label: "Memory ls",
      guideline:
        "Use memory_ls without a path to see which memory files exist.",
      descriptionNote: "Pass limit to change the entry cap.",
    }),
  );

  pi.registerTool(
    scoped(createWriteToolDefinition(memoryRoot), {
      name: "memory_write",
      label: "Memory write",
      guideline:
        "Use memory_write to save or update a memory instead of the generic write tools.",
    }),
  );

  pi.registerTool({
    name: "memory_delete",
    label: "Memory delete",
    description:
      "Delete a memory file that turned out to be wrong or obsolete. " +
      "Remember to also drop its line from MEMORY.md with memory_write.\n\n" +
      SCOPE_NOTE,
    promptSnippet: "Delete a memory file",
    promptGuidelines: [
      "Use memory_delete to remove a memory file instead of shelling out to rm.",
    ],
    parameters: Type.Object({
      path: Type.String({
        description: "Memory file to delete, relative to the memory directory",
      }),
    }),

    async execute(_toolCallId, params) {
      const resolved = await ensureInMemory(params.path);
      try {
        await unlink(resolved);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`There is no memory file at ${resolved}.`);
        }
        throw error;
      }
      return {
        content: [{ type: "text", text: `Deleted ${resolved}.` }],
        details: { path: resolved },
      };
    },
  });
}

interface ScopeOptions {
  name: string;
  label: string;
  guideline: string;
  // Appended to the built-in description. The bridge to other harnesses drops per-parameter
  // descriptions, so anything the model must know about parameters has to be said here.
  descriptionNote?: string;
}

// Wraps a built-in tool definition under a new name, with relative paths resolved against
// the memory directory instead of the cwd. Spreading keeps the built-in renderers, so the
// UI (syntax highlighting, truncation notices) is unchanged. Only execute() is intercepted,
// to reject paths that land outside the memory directory.
function scoped(
  definition: ToolDefinition<any, any, any>,
  options: ScopeOptions,
): ToolDefinition<any, any, any> {
  const { name, label, guideline, descriptionNote } = options;
  return {
    ...definition,
    name,
    label,
    description: `${definition.description}${
      descriptionNote === undefined ? "" : ` ${descriptionNote}`
    }\n\n${SCOPE_NOTE}`,
    promptGuidelines: [guideline],
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      await ensureInMemory(params.path);
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

// Returns the resolved absolute path, or throws when it leaves the memory directory.
// Symlinks are followed first, so a link inside the memory directory cannot be used to
// reach outside it.
async function ensureInMemory(target: string | undefined): Promise<string> {
  const root = await resolveThroughSymlinks(memoryDirectory());
  const anchored =
    target !== undefined && (isAbsolute(target) || target.startsWith("~"))
      ? target
      : join(root, target ?? "");
  const resolved = await resolveThroughSymlinks(anchored);

  if (!contains(root, resolved)) {
    throw new Error(
      `${resolved} is outside the memory directory at ${root}. ` +
        "The memory_* tools only touch memory files; use the regular file tools for everything else.",
    );
  }
  return resolved;
}
