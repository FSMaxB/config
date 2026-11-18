import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAssistantMessage, parseReportedUsage, parseStreamEvent } from "../src/stream-events.ts";

describe("parseStreamEvent", () => {
	it("keeps a block event's index and parses its block", () => {
		// arrange
		const event = { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "call", name: "read", input: { path: "a" } } };
		const expected = { type: "content_block_start", index: 2, block: { type: "tool_use", id: "call", name: "read", input: { path: "a" } } };

		// act
		const parsed = parseStreamEvent(event);

		// assert
		assert.deepEqual(parsed, expected);
	});

	it("reports a block event without an index as unknown", () => {
		// arrange
		const event = { type: "content_block_stop" };
		const expected = { type: "unknown", eventType: "content_block_stop" };

		// act
		const parsed = parseStreamEvent(event);

		// assert
		assert.deepEqual(parsed, expected);
	});

	it("reports a delta whose payload field is missing as unknown", () => {
		// arrange
		const event = { type: "content_block_delta", index: 0, delta: { type: "text_delta" } };
		const expected = { type: "content_block_delta", index: 0, delta: { type: "unknown", deltaType: "text_delta" } };

		// act
		const parsed = parseStreamEvent(event);

		// assert
		assert.deepEqual(parsed, expected);
	});

	it("parses a message_start without a message", () => {
		// arrange
		const expected = { type: "message_start", messageId: undefined, model: undefined, usage: undefined };

		// act
		const parsed = parseStreamEvent({ type: "message_start" });

		// assert
		assert.deepEqual(parsed, expected);
	});
});

describe("parseAssistantMessage", () => {
	it("is undefined without a content array", () => {
		// act
		const parsed = parseAssistantMessage({ id: "msg" });

		// assert
		assert.equal(parsed, undefined);
	});

	it("parses redacted thinking and a fallback block", () => {
		// arrange
		const message = { id: "msg", content: [{ type: "thinking" }, { type: "fallback", to: { model: "claude-sonnet" } }, { type: "mystery" }] };
		const expected = [
			{ type: "thinking", thinking: "", signature: "" },
			{ type: "fallback", model: "claude-sonnet" },
			{ type: "unknown", blockType: "mystery" },
		];

		// act
		const parsed = parseAssistantMessage(message);

		// assert
		assert.deepEqual(parsed?.content, expected);
	});
});

describe("parseReportedUsage", () => {
	it("treats null and missing counters as undefined", () => {
		// arrange
		const expected = { input: 3, output: undefined, cacheRead: undefined, cacheWrite: 5 };

		// act
		const parsed = parseReportedUsage({ input_tokens: 3, output_tokens: null, cache_creation_input_tokens: 5 });

		// assert
		assert.deepEqual(parsed, expected);
	});
});
