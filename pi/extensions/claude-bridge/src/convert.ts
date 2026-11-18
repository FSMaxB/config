// Pure pi→Anthropic message conversion helpers, testable without the full extension runtime.

import type { Message as PiMessage } from "@earendil-works/pi-ai";
import type { ContentBlock, Message as SessionMessage } from "cc-session-io";
import { pascalCase } from "change-case";

export const PROVIDER_ID = "pi-claude";

export const PI_TO_SDK_TOOL_NAME: Record<string, string> = {
	read: "Read", write: "Write", edit: "Edit", bash: "Bash",
};

export function sanitizeToolId(id: string, cache: Map<string, string>): string {
	const existing = cache.get(id);
	if (existing) return existing;
	const clean = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	cache.set(id, clean);
	return clean;
}

export function mapPiToolNameToSdk(name: string, customToolNameToSdk?: ReadonlyMap<string, string>): string {
	if (!name) return "";
	const normalized = name.toLowerCase();
	if (customToolNameToSdk) {
		const mapped = customToolNameToSdk.get(name) ?? customToolNameToSdk.get(normalized);
		if (mapped) return mapped;
	}
	if (PI_TO_SDK_TOOL_NAME[normalized]) return PI_TO_SDK_TOOL_NAME[normalized];
	return pascalCase(name);
}

export function messageContentToText(
	content: string | ReadonlyArray<{ type: string; text?: string; data?: string; mimeType?: string }>,
): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	let hasText = false;
	for (const block of content) {
		if (block.type === "text" && block.text) { parts.push(block.text); hasText = true; }
		else if (block.type !== "text" && block.type !== "image") { parts.push(`[${block.type}]`); }
	}
	return hasText ? parts.join("\n") : "";
}

function imageBlockToAnthropic(block: { data?: string; mimeType?: string }): ContentBlock | undefined {
	if (!block.data || !block.mimeType) return undefined;
	return { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } } as ContentBlock;
}

function toolResultContentToAnthropic(
	content: string | ReadonlyArray<{ type: string; text?: string; data?: string; mimeType?: string }>,
): string | ContentBlock[] {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const blocks: ContentBlock[] = [];
	for (const block of content) {
		if (block.type === "text" && block.text) {
			blocks.push({ type: "text", text: block.text });
		} else if (block.type === "image") {
			const image = imageBlockToAnthropic(block);
			if (image) blocks.push(image);
		} else if (block.type) {
			blocks.push({ type: "text", text: `[${block.type}]` });
		}
	}
	if (blocks.length === 0) return "";
	if (blocks.every((block) => block.type === "text")) return blocks.map((block) => (block as { text: string }).text).join("\n");
	return blocks;
}

function assistantProvenancePrefix(message: PiMessage): string | undefined {
	if (message.role !== "assistant") return undefined;
	const provider = typeof (message as any).provider === "string" ? (message as any).provider : undefined;
	const model = typeof (message as any).model === "string" ? (message as any).model : undefined;
	const api = typeof (message as any).api === "string" ? (message as any).api : undefined;
	if (!provider && !model && !api) return undefined;
	if (provider === PROVIDER_ID || isAnthropicApi(api)) return undefined;
	return `[Prior Pi assistant response from ${provider ?? api ?? "unknown-provider"}${model ? `/${model}` : ""}]\n`;
}

function userMessageToAnthropic(message: PiMessage): SessionMessage {
	if (typeof message.content === "string") return { role: "user", content: message.content || "[empty]" };
	if (Array.isArray(message.content)) {
		const parts = [];
		for (const block of message.content) {
			if (block.type === "text" && block.text) parts.push({ type: "text", text: block.text });
			else if (block.type === "image" && block.data && block.mimeType) parts.push(imageBlockToAnthropic(block));
		}
		const kept = parts.filter(Boolean) as ContentBlock[];
		return { role: "user", content: kept.length ? kept : "[image]" };
	}
	return { role: "user", content: "[empty]" };
}

function toolResultToAnthropicBlock(message: PiMessage, sanitizedIds: Map<string, string>): ContentBlock {
	const content = toolResultContentToAnthropic(message.content as string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>);
	return {
		type: "tool_result",
		tool_use_id: sanitizeToolId((message as { toolCallId: string }).toolCallId, sanitizedIds),
		content: content || "",
		is_error: (message as { isError?: boolean }).isError,
	} as ContentBlock;
}

function hasToolUse(message: PiMessage): boolean {
	return message.role === "assistant" && Array.isArray(message.content) && message.content.some((block) => block.type === "toolCall");
}

/** Convert pi message array to Anthropic API format. */
export function convertPiMessages(
	messages: readonly PiMessage[],
	customToolNameToSdk?: ReadonlyMap<string, string>,
): { anthropicMessages: SessionMessage[]; sanitizedIds: Map<string, string> } {
	const anthropicMessages = [];
	const sanitizedIds = new Map();

	const pushToolResultGroup = (toolMessages: readonly PiMessage[]): void => {
		if (toolMessages.length === 0) return;
		anthropicMessages.push({
			role: "user",
			content: toolMessages.map((toolMessage) => toolResultToAnthropicBlock(toolMessage, sanitizedIds)),
		});
	};

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		// Pi 0.86+ records prompt and tool-set changes as system messages. Claude
		// Code owns its own system prompt and receives Pi's current prompt-derived
		// append with every query, so a system message has no record to import.
		if (message.role === "system") continue;
		if (message.role === "user") {
			// Rebuild imports each pi user message as its OWN record. The REUSE path
			// (extractUserPrompt/extractUserPromptBlocks in index.ts) instead merges a
			// trailing user run into one "\n\n"-joined prompt — accepted divergence,
			// see the comment there; the merged form is never re-imported here.
			anthropicMessages.push(userMessageToAnthropic(message));
		} else if (message.role === "assistant") {
			const content = Array.isArray(message.content) ? message.content : [];
			const blocks = [];
			const provenance = assistantProvenancePrefix(message);
			if (provenance) blocks.push({ type: "text", text: provenance });
			for (const block of content) {
				if (block.type === "text" && block.text) {
					blocks.push({ type: "text", text: block.text });
				} else if (block.type === "thinking") {
					const sig = block.thinkingSignature;
					const isAnthropicProvider = message.provider === PROVIDER_ID || isAnthropicApi(message.api);
					if (isAnthropicProvider && sig) {
						blocks.push({ type: "thinking", thinking: block.thinking ?? "", signature: sig });
					}
				} else if (block.type === "toolCall") {
					const toolName = mapPiToolNameToSdk(block.name, customToolNameToSdk);
					blocks.push({ type: "tool_use", id: sanitizeToolId(block.id, sanitizedIds), name: toolName, input: block.arguments ?? {} });
				}
			}
			if (!blocks.length) blocks.push({ type: "text", text: "[incompatible content omitted]" });
			anthropicMessages.push({ role: "assistant", content: blocks });

			// Pi may inject steer/followUp user messages between parallel tool
			// results, while runtime extraction treats every toolResult after the
			// assistant (until the next assistant) as one turn. Claude history must
			// put all tool_result blocks immediately after the tool_use assistant;
			// replay interleaved user text only after that grouped result message.
			if (hasToolUse(message)) {
				const toolMessages: PiMessage[] = [];
				const interleavedUsers: PiMessage[] = [];
				let j = i + 1;
				for (; j < messages.length; j++) {
					const next = messages[j];
					if (next.role === "assistant") break;
					if (next.role === "toolResult") toolMessages.push(next);
					else if (next.role === "user") interleavedUsers.push(next);
					else if (next.role === "system") continue;
					else break;
				}
				if (toolMessages.length > 0) {
					pushToolResultGroup(toolMessages);
					for (const userMessage of interleavedUsers) anthropicMessages.push(userMessageToAnthropic(userMessage));
					i = j - 1;
				}
			}
		} else if (message.role === "toolResult") {
			const blocks: ContentBlock[] = [];
			for (; i < messages.length; i++) {
				const toolMsg = messages[i];
				if (toolMsg.role !== "toolResult") { i--; break; }
				blocks.push(toolResultToAnthropicBlock(toolMsg, sanitizedIds));
			}
			anthropicMessages.push({ role: "user", content: blocks });
		}
	}

	return { anthropicMessages, sanitizedIds };
}

/** Pi's native Anthropic provider uses "anthropic-messages". */
function isAnthropicApi(api: string | undefined): boolean {
	return api === "anthropic" || api === "anthropic-messages";
}
