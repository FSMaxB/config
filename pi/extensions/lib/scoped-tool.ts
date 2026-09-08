import type {
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { renameRenderedTitle } from "./tool-title.ts";

export interface ScopedToolOptions {
  name: string;
  label: string;
  guideline: string;
  scopeNote: string;
  // Appended to the built-in description. The bridge to other harnesses drops per-parameter
  // descriptions, so anything the model must know about parameters has to be said here.
  descriptionNote?: string;
  // Returns the absolute path the call must operate on, which replaces the caller's path.
  ensurePath: (
    params: { path?: string },
    ctx: ExtensionContext,
  ) => Promise<string>;
}

// Wraps a built-in tool definition under a new name, with its path parameter checked against
// a caller-supplied scope before running. Spreading keeps the built-in renderers, so the UI
// (syntax highlighting, edit diffs, truncation notices) is unchanged, while the call title is
// renamed to match the wrapper. Only execution and call-title rendering are intercepted.
//
// The checked path is substituted back into the parameters, because the built-in tools resolve
// a relative path against the live `ctx.cwd` rather than the cwd their definition was created
// with. Without the substitution a scope check and the operation it guards can disagree: the
// memory tools would validate `MEMORY.md` inside the memory directory and then read or write it
// in the session's working directory.
export function scopedTool(
  definition: ToolDefinition<any, any, any>,
  options: ScopedToolOptions,
): ToolDefinition<any, any, any> {
  const { name, label, guideline, scopeNote, descriptionNote, ensurePath } =
    options;
  return {
    ...definition,
    name,
    label,
    description: `${definition.description}${
      descriptionNote === undefined ? "" : ` ${descriptionNote}`
    }\n\n${scopeNote}`,
    promptGuidelines: [guideline],
    renderCall: renameRenderedTitle(definition, name),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const path = await ensurePath(params as { path?: string }, ctx);
      return await definition.execute(
        toolCallId,
        { ...(params as Record<string, unknown>), path },
        signal,
        onUpdate,
        ctx,
      );
    },
  };
}
