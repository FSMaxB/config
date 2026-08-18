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
  ensurePath: (
    params: { path?: string },
    ctx: ExtensionContext,
  ) => Promise<unknown>;
}

// Wraps a built-in tool definition under a new name, with its path parameter checked against
// a caller-supplied scope before running. Spreading keeps the built-in renderers, so the UI
// (syntax highlighting, edit diffs, truncation notices) is unchanged, while the call title is
// renamed to match the wrapper. Only execution and call-title rendering are intercepted.
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
      await ensurePath(params as { path?: string }, ctx);
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
