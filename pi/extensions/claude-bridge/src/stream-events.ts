import { isRecord, stringProperty } from "../../lib/untyped.ts";

export function parseStreamEvent(event: unknown): StreamEvent {
	if (!isRecord(event)) return { type: "unknown", eventType: undefined };
	const eventType = stringProperty(event, "type");
	switch (eventType) {
		case "ping":
			return { type: "ping" };
		case "message_start":
			return parseMessageStart(event);
		case "content_block_start": {
			const index = numberProperty(event, "index");
			if (index === undefined) return { type: "unknown", eventType };
			return { type: "content_block_start", index, block: parseStartedBlock(event.content_block) };
		}
		case "content_block_delta": {
			const index = numberProperty(event, "index");
			if (index === undefined) return { type: "unknown", eventType };
			return { type: "content_block_delta", index, delta: parseBlockDelta(event.delta) };
		}
		case "content_block_stop": {
			const index = numberProperty(event, "index");
			if (index === undefined) return { type: "unknown", eventType };
			return { type: "content_block_stop", index };
		}
		case "message_delta": {
			const delta = isRecord(event.delta) ? event.delta : undefined;
			return {
				type: "message_delta",
				stopReason: delta === undefined ? undefined : stringProperty(delta, "stop_reason"),
				usage: parseReportedUsage(event.usage),
			};
		}
		case "message_stop":
			return { type: "message_stop" };
		case undefined:
		default:
			return { type: "unknown", eventType };
	}
}

export function parseAssistantMessage(message: unknown): CompletedAssistantMessage | undefined {
	if (!isRecord(message) || !Array.isArray(message.content)) return undefined;
	const content: unknown[] = message.content;
	return {
		id: stringProperty(message, "id"),
		model: stringProperty(message, "model"),
		content: content.map(parseCompletedBlock),
		usage: parseReportedUsage(message.usage),
	};
}

function parseMessageStart(event: Record<string, unknown>): StreamEvent {
	const message = isRecord(event.message) ? event.message : undefined;
	return {
		type: "message_start",
		messageId: message === undefined ? undefined : stringProperty(message, "id"),
		model: message === undefined ? undefined : stringProperty(message, "model"),
		usage: message === undefined ? undefined : parseReportedUsage(message.usage),
	};
}

function parseStartedBlock(block: unknown): StartedBlock {
	if (!isRecord(block)) return { type: "unknown", blockType: undefined };
	const blockType = stringProperty(block, "type");
	switch (blockType) {
		case "text":
			return { type: "text" };
		case "thinking":
			return { type: "thinking" };
		case "tool_use":
			return { type: "tool_use", id: stringProperty(block, "id") ?? "", name: stringProperty(block, "name") ?? "", input: block.input };
		case undefined:
		default:
			return { type: "unknown", blockType };
	}
}

function parseBlockDelta(delta: unknown): BlockDelta {
	if (!isRecord(delta)) return { type: "unknown", deltaType: undefined };
	const deltaType = stringProperty(delta, "type");
	switch (deltaType) {
		case "text_delta": {
			const text = stringProperty(delta, "text");
			return text === undefined ? { type: "unknown", deltaType } : { type: "text_delta", text };
		}
		case "thinking_delta": {
			const thinking = stringProperty(delta, "thinking");
			return thinking === undefined ? { type: "unknown", deltaType } : { type: "thinking_delta", thinking };
		}
		case "input_json_delta": {
			const partialJson = stringProperty(delta, "partial_json");
			return partialJson === undefined ? { type: "unknown", deltaType } : { type: "input_json_delta", partialJson };
		}
		case "signature_delta": {
			const signature = stringProperty(delta, "signature");
			return signature === undefined ? { type: "unknown", deltaType } : { type: "signature_delta", signature };
		}
		case undefined:
		default:
			return { type: "unknown", deltaType };
	}
}

function parseCompletedBlock(block: unknown): CompletedBlock {
	if (!isRecord(block)) return { type: "unknown", blockType: undefined };
	const blockType = stringProperty(block, "type");
	switch (blockType) {
		case "text":
			return { type: "text", text: stringProperty(block, "text") ?? "" };
		case "thinking":
			return { type: "thinking", thinking: stringProperty(block, "thinking") ?? "", signature: stringProperty(block, "signature") ?? "" };
		case "tool_use":
			return { type: "tool_use", id: stringProperty(block, "id") ?? "", name: stringProperty(block, "name") ?? "", input: block.input };
		case "fallback": {
			const target = isRecord(block.to) ? block.to : undefined;
			return { type: "fallback", model: target === undefined ? undefined : stringProperty(target, "model") };
		}
		case undefined:
		default:
			return { type: "unknown", blockType };
	}
}

export function parseReportedUsage(usage: unknown): ReportedUsage | undefined {
	if (!isRecord(usage)) return undefined;
	return {
		input: numberProperty(usage, "input_tokens"),
		output: numberProperty(usage, "output_tokens"),
		cacheRead: numberProperty(usage, "cache_read_input_tokens"),
		cacheWrite: numberProperty(usage, "cache_creation_input_tokens"),
	};
}

function numberProperty(value: object, key: string): number | undefined {
	const property: unknown = Reflect.get(value, key);
	return typeof property === "number" ? property : undefined;
}

// Claude Code's stream events as the bridge reads them. Partial payloads from test doubles and older
// CLIs parse to undefined fields or to an "unknown" variant instead of failing.
export type StreamEvent =
	| { type: "ping" }
	| { type: "message_start"; messageId: string | undefined; model: string | undefined; usage: ReportedUsage | undefined }
	| { type: "content_block_start"; index: number; block: StartedBlock }
	| { type: "content_block_delta"; index: number; delta: BlockDelta }
	| { type: "content_block_stop"; index: number }
	| { type: "message_delta"; stopReason: string | undefined; usage: ReportedUsage | undefined }
	| { type: "message_stop" }
	| { type: "unknown"; eventType: string | undefined };

export type StartedBlock =
	| { type: "text" }
	| { type: "thinking" }
	// A call without an id or a name still happened in the child: they parse to "", which is never dispatchable.
	| { type: "tool_use"; id: string; name: string; input: unknown }
	| { type: "unknown"; blockType: string | undefined };

export type BlockDelta =
	| { type: "text_delta"; text: string }
	| { type: "thinking_delta"; thinking: string }
	| { type: "input_json_delta"; partialJson: string }
	| { type: "signature_delta"; signature: string }
	| { type: "unknown"; deltaType: string | undefined };

export interface CompletedAssistantMessage {
	readonly id: string | undefined;
	readonly model: string | undefined;
	readonly content: readonly CompletedBlock[];
	readonly usage: ReportedUsage | undefined;
}

export type CompletedBlock =
	| { type: "text"; text: string }
	// Claude Code omits the text of redacted thinking; it parses to "".
	| { type: "thinking"; thinking: string; signature: string }
	| { type: "tool_use"; id: string; name: string; input: unknown }
	| { type: "fallback"; model: string | undefined }
	| { type: "unknown"; blockType: string | undefined };

// The API reports a counter it does not know yet as null; null and a missing counter both parse to undefined.
export interface ReportedUsage {
	readonly input: number | undefined;
	readonly output: number | undefined;
	readonly cacheRead: number | undefined;
	readonly cacheWrite: number | undefined;
}
