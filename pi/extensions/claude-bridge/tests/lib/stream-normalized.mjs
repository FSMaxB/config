import { normalizeContext } from "@earendil-works/pi-ai";
import { streamClaudeAgentSdk } from "../../src/index.ts";

/** Pi normalizes every provider context before calling streamSimple (pi-agent-core
 *  agent-loop.js, streamAssistantResponse), so tests hand the bridge the same
 *  shape: `tools` and `systemPrompt` become the leading system message. */
export function streamNormalized(model, context, options) {
	return streamClaudeAgentSdk(model, normalizeContext(context), options);
}
