import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { processAssistantMessage, processStreamEvent } from "../src/index.ts";
import { ctx, resetStack } from "../src/query-state.ts";
import { model, installFakeStream, streamEvent } from "./lib/tool-stream.mjs";
import { cancelScheduledToolUseEnd, endToolUseTurn } from "../src/assistant-stream.ts";
afterEach(() => cancelScheduledToolUseEnd(ctx()));
describe("usage across a Pi turn that spans several child messages", () => {
	beforeEach(() => resetStack());

	it("accumulates what each finished child message billed", () => {
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();

		// Child message 1: the connector call. Big cache write, tiny output.
		processStreamEvent(streamEvent({
			type: "message_start",
			message: { id: "msg_1", model: model.id, usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 55685 } },
		}), new Map(), model);
		processStreamEvent(streamEvent({ type: "message_delta", delta: {}, usage: { output_tokens: 3 } }), new Map(), model);

		// Child message 2: the answer. Its own separate billed call.
		processStreamEvent(streamEvent({
			type: "message_start",
			message: { id: "msg_2", model: model.id, usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 53631, cache_creation_input_tokens: 2083 } },
		}), new Map(), model);
		processStreamEvent(streamEvent({ type: "message_delta", delta: {}, usage: { output_tokens: 110 } }), new Map(), model);

		assert.equal(c.turnOutput.usage.input, 15, "both calls' input is billed");
		assert.equal(c.turnOutput.usage.output, 113);
		assert.equal(c.turnOutput.usage.cacheRead, 53631);
		assert.equal(c.turnOutput.usage.cacheWrite, 57768, "the first message's cache write must not be dropped");
		assert.equal(c.turnOutput.usage.totalTokens, 15 + 113 + 53631 + 57768);
		processStreamEvent(streamEvent({
			type: "message_start",
			message: { id: "msg_3", model: model.id, usage: { input_tokens: 7, output_tokens: 0 } },
		}), new Map(), model);
		processStreamEvent(streamEvent({ type: "message_delta", delta: {}, usage: { output_tokens: 11 } }), new Map(), model);
		assert.deepEqual({ input: c.turnOutput.usage.input, output: c.turnOutput.usage.output, cacheRead: c.turnOutput.usage.cacheRead, cacheWrite: c.turnOutput.usage.cacheWrite, total: c.turnOutput.usage.totalTokens }, { input: 22, output: 124, cacheRead: 53631, cacheWrite: 57768, total: 22 + 124 + 53631 + 57768 });
	});

	it("replaces rather than doubles within one child message", () => {
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();

		processStreamEvent(streamEvent({
			type: "message_start",
			message: { model: model.id, usage: { input_tokens: 10, output_tokens: 0 } },
		}), new Map(), model);
		// Anthropic re-reports the same message's growing output.
		processStreamEvent(streamEvent({ type: "message_delta", delta: {}, usage: { output_tokens: 40 } }), new Map(), model);
		processStreamEvent(streamEvent({ type: "message_delta", delta: {}, usage: { output_tokens: 90 } }), new Map(), model);

		assert.equal(c.turnOutput.usage.input, 10);
		assert.equal(c.turnOutput.usage.output, 90, "cumulative-per-message counters must not be summed");
	});

	it("accumulates on the no-stream-events path too", () => {
		// The SDK can deliver a turn as complete `assistant` messages with no
		// stream events. That path begins the following child message, so
		// it must bank the previous one exactly as `message_start` does.
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();

		processAssistantMessage({
			type: "assistant",
			message: { id: "msg_1", content: [{ type: "text", text: "first" }], usage: { input_tokens: 10, output_tokens: 20 } },
		}, model, new Map());
		processAssistantMessage({
			type: "assistant",
			message: { id: "msg_2", content: [{ type: "text", text: "second" }], usage: { input_tokens: 5, output_tokens: 7 } },
		}, model, new Map());

		assert.equal(c.turnOutput.usage.input, 15);
		assert.equal(c.turnOutput.usage.output, 27, "the first assistant message's output must not be dropped");
	});

	it("does not double-count a message whose message_start already streamed", () => {
		// A child message that emits message_start but
		// NO content blocks leaves `turnSawStreamEvent` false, so the SDK's completed
		// copy of that SAME message lands on the no-stream-events path. Banking per
		// call site counted it twice; banking per message id does not.
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();

		processStreamEvent(streamEvent({
			type: "message_start",
			message: { id: "msg_1", model: model.id, usage: { input_tokens: 10, output_tokens: 0 } },
		}), new Map(), model);
		processStreamEvent(streamEvent({ type: "message_delta", delta: {}, usage: { output_tokens: 40 } }), new Map(), model);
		// The SDK's completed copy of the SAME message (same id).
		processAssistantMessage({
			type: "assistant",
			message: { id: "msg_1", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 10, output_tokens: 40 } },
		}, model, new Map());

		assert.equal(c.turnOutput.usage.input, 10, "one message must be billed once");
		assert.equal(c.turnOutput.usage.output, 40);
	});

	it("still accumulates when the SDK reports no message ids", () => {
		// Older/streamless shapes carry no id. Each call then means what it says.
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();

		processAssistantMessage({
			type: "assistant",
			message: { content: [{ type: "text", text: "a" }], usage: { input_tokens: 3, output_tokens: 4 } },
		}, model, new Map());
		processAssistantMessage({
			type: "assistant",
			message: { content: [{ type: "text", text: "b" }], usage: { input_tokens: 3, output_tokens: 4 } },
		}, model, new Map());

		assert.equal(c.turnOutput.usage.input, 6);
		assert.equal(c.turnOutput.usage.output, 8);
	});

	it("starts fresh for the next Pi message", () => {
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();
		processStreamEvent(streamEvent({
			type: "message_start",
			message: { model: model.id, usage: { input_tokens: 10, output_tokens: 7 } },
		}), new Map(), model);

		c.resetTurnState(model);
		installFakeStream();
		processStreamEvent(streamEvent({
			type: "message_start",
			message: { model: model.id, usage: { input_tokens: 4, output_tokens: 2 } },
		}), new Map(), model);

		assert.equal(c.turnOutput.usage.input, 4, "a new Pi message does not inherit the old turn's total");
		assert.equal(c.turnOutput.usage.output, 2);
	});
});

describe("usage of a child message split across Pi turns", () => {
	beforeEach(() => resetStack());

	const tools = new Map([["mcp__custom-tools__read", "read"]]);
	const splitUsage = { input_tokens: 32, output_tokens: 2, cache_read_input_tokens: 44241, cache_creation_input_tokens: 817 };

	function deliverFirstTurn(c) {
		c.resetTurnState(model);
		installFakeStream();
		processStreamEvent(streamEvent({ type: "message_start", message: { id: "msg_split", model: model.id, usage: splitUsage } }), tools, model);
		endToolUseTurn(c);
	}

	it("bills nothing again for a replayed turn of an already billed message", () => {
		// arrange
		const c = ctx();
		deliverFirstTurn(c);
		c.resetTurnState(model);
		const events = installFakeStream();

		// act
		processAssistantMessage({
			type: "assistant",
			message: { id: "msg_split", content: [{ type: "tool_use", id: "toolu_replayed", name: "mcp__custom-tools__read", input: { file_path: "a.md" } }], usage: splitUsage },
		}, model, tools);

		// assert
		const done = events.find((event) => event.type === "done");
		assert.deepEqual(
			{ input: done.message.usage.input, output: done.message.usage.output, cacheRead: done.message.usage.cacheRead, cacheWrite: done.message.usage.cacheWrite, total: done.message.usage.totalTokens },
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		);
	});

	it("bills output that arrives after the first turn was delivered", () => {
		// arrange
		const c = ctx();
		deliverFirstTurn(c);
		c.resetTurnState(model);
		installFakeStream();

		// act
		processStreamEvent(streamEvent({ type: "message_start", message: { id: "msg_split", model: model.id, usage: splitUsage } }), tools, model);
		processStreamEvent(streamEvent({ type: "message_delta", delta: {}, usage: { output_tokens: 950 } }), tools, model);

		// assert
		assert.deepEqual(
			{ input: c.turnOutput.usage.input, output: c.turnOutput.usage.output, cacheRead: c.turnOutput.usage.cacheRead, cacheWrite: c.turnOutput.usage.cacheWrite },
			{ input: 0, output: 948, cacheRead: 0, cacheWrite: 0 },
		);
	});

	it("does not bank an already billed message into the next message's turn", () => {
		// arrange
		const c = ctx();
		deliverFirstTurn(c);
		c.resetTurnState(model);
		installFakeStream();

		// act
		processStreamEvent(streamEvent({ type: "message_start", message: { id: "msg_split", model: model.id, usage: splitUsage } }), tools, model);
		processStreamEvent(streamEvent({
			type: "message_start",
			message: { id: "msg_next", model: model.id, usage: { input_tokens: 32, output_tokens: 2, cache_read_input_tokens: 45058, cache_creation_input_tokens: 18970 } },
		}), tools, model);

		// assert
		assert.deepEqual(
			{ input: c.turnOutput.usage.input, output: c.turnOutput.usage.output, cacheRead: c.turnOutput.usage.cacheRead, cacheWrite: c.turnOutput.usage.cacheWrite },
			{ input: 32, output: 2, cacheRead: 45058, cacheWrite: 18970 },
		);
	});
});
