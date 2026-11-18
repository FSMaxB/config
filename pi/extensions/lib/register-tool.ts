import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

// Pi renders promptGuidelines into its native system prompt, but harness bridges
// (e.g. pi-claude-bridge) forward only the tool description. Merging the guidelines
// into the description is the one channel that reaches every harness; native
// sessions see the text twice, which is benign.
export function registerToolWithGuidelines<TParameters extends TSchema, TDetails = unknown>(
  pi: ExtensionAPI,
  definition: ToolDefinition<TParameters, TDetails>,
): void {
  const { description, promptGuidelines = [] } = definition;
  pi.registerTool({
    ...definition,
    description: [description, ...promptGuidelines].join(" "),
  });
}
