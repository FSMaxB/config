// Tool-result extraction: walks the context tail to collect this turn's
// tool results. Pi appends results to context and calls the provider again;
// this scrapes them back out. Walks past user messages (steer/followUp) that
// pi may inject between toolResults. Stops at the nearest assistant message
// (turn boundary). A module of its own so tests can import it without activating the extension.

import { isRecord } from "../../lib/untyped.ts";

export type McpContent = (
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
)[];

export interface McpResult {
	content: McpContent;
	isError?: boolean;
	toolCallId?: string;
	[key: string]: unknown;
}

// Pi's tool result content: a string, or text and image blocks.
export function toolResultToMcpContent(content: unknown): McpContent {
	if (typeof content === "string") return [{ type: "text", text: content || "" }];
	if (!Array.isArray(content)) return [{ type: "text", text: "" }];
	const blocks: McpContent = [];
	for (const block of content) {
		if (!isRecord(block)) continue;
		const { type, text, data, mimeType } = block;
		if (type === "text" && typeof text === "string" && text) blocks.push({ type: "text", text });
		else if (type === "image" && typeof data === "string" && data && typeof mimeType === "string" && mimeType) blocks.push({ type: "image", data, mimeType });
	}
	return blocks.length ? blocks : [{ type: "text", text: "" }];
}

// Returns { results, stopIdx } so callers can log the walk boundary.
export function extractAllToolResults(
	messages: readonly { role: string; content?: unknown; toolCallId?: string; isError?: boolean }[],
): { results: McpResult[]; stopIdx: number } {
	const results: McpResult[] = [];
	let stopIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "toolResult") {
			results.unshift({ content: toolResultToMcpContent(message.content), isError: message.isError, toolCallId: message.toolCallId });
		} else if (message.role === "assistant") { stopIndex = i; break; }
		// user messages (steer/followUp injected mid-tool-execution) and system
		// messages (a prompt or tool-set change Pi recorded at the boundary): skip
	}
	return { results, stopIdx: stopIndex };
}
