/** A request that reuses a busy session's id must never be served as a
 *  callback of that session's running query. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { __testGetBridgeIntegrityState, __testSetBridgeIntegrityState, __testSetSdkQueryFactory } from "../src/index.ts";
import { __testSharedSessionLaneCount, setExtensionApi } from "../src/bridge-state.ts";
import { __testQueryLaneCount, ctx, resetStack } from "../src/query-state.ts";
import { runInRequestLane } from "../src/request-lane.ts";
import { streamNormalized } from "./lib/stream-normalized.mjs";
import { waitFor } from "./lib/wait-for.mjs";

const model = {
	id: "claude-haiku-4-5", name: "Claude Haiku", api: "claude-bridge", provider: "pi-claude", baseUrl: "claude-bridge",
	reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000, maxTokens: 8192,
};
const tool = { name: "mytool", description: "", parameters: { type: "object" } };
const PARENT = "parent-session";
// Prompts whose fake query stays open until its gate opens, like a real query
// waiting on a tool or on the model.
const WAITING_PROMPTS = new Set(["parent", "streaming", "hang"]);

const queries = new Map();
const cleanups = [];
let server;
let root;
let previousEnv;

const userMessage = (text) => ({ role: "user", content: text, timestamp: Date.now() });

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bridge-one-shot-"));
	const env = { CLAUDE_CONFIG_DIR: root, PI_CODING_AGENT_DIR: root, CLAUDE_CODE_OAUTH_TOKEN: "offline-test", CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT: "0" };
	previousEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify() {} } });
	setExtensionApi({ events: { emit() {} }, appendEntry() {} });
	__testSetSdkQueryFactory(fakeSdk);
});

afterEach(async () => {
	for (const { gate } of queries.values()) gate.resolve();
	await waitFor(() => runInRequestLane(PARENT, () => ctx().activeQuery === null));
	for (const close of cleanups.splice(0)) await close();
	queries.clear();
	server = undefined;
	__testSetSdkQueryFactory();
	setExtensionApi(undefined);
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
	resetStack();
	for (const [key, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	rmSync(root, { recursive: true, force: true });
});

describe("one-shot requests on a busy session id", () => {
	it("runs a cacheRetention:none request as its own query while the parent waits on a tool", { timeout: 5000 }, async () => {
		// arrange
		await startParentToolTurn();
		const { pendingCall } = await callParentTool();
		const before = parentState();
		const queryLanesBefore = __testQueryLaneCount();

		// act
		const answer = await collect(streamNormalized(model, { systemPrompt: "Answer from the page.", messages: [userMessage("what does the page say")] }, { sessionId: PARENT, cacheRetention: "none", cwd: root }));

		// assert
		assert.deepEqual(textDeltas(answer), ["answer-what does the page say"]);
		assert.equal(answer.at(-1).type, "done");
		assert.equal(queries.get("what does the page say").options.resume, undefined, "the one-shot never resumes the parent's Claude session");
		const after = parentState();
		assert.equal(after.activeQuery, before.activeQuery);
		assert.equal(after.currentPiStream, before.currentPiStream);
		assert.deepEqual(after.deferredUserMessages, []);
		assert.equal(after.latestCursor, before.latestCursor);
		assert.deepEqual(after.sharedSession, before.sharedSession);
		assert.equal(await waitFor(() => __testQueryLaneCount() === queryLanesBefore), true, "only the one-shot's own lane is released");

		// act
		const delivery = collect(streamNormalized(model, toolLoopContext(), { sessionId: PARENT, cwd: root }));
		const toolResult = await pendingCall;
		queries.get("parent").gate.resolve();

		// assert
		assert.equal(toolResult.content[0].text, "parent-output");
		assert.equal((await delivery).at(-1).type, "done");
	});

	it("keeps the session's record when a cacheRetention:none request reuses its id while idle", { timeout: 5000 }, async () => {
		// arrange
		const record = { sessionId: "parent-claude-session", cursor: 4, cwd: root };
		runInRequestLane(PARENT, () => __testSetBridgeIntegrityState({ sharedSession: { ...record } }));

		// act
		await collect(streamNormalized(model, { messages: [userMessage("summarize")] }, { sessionId: PARENT, cacheRetention: "none", cwd: root }));

		// assert
		assert.equal(await waitFor(() => __testSharedSessionLaneCount() === 1), true, "the one-shot's private record is released");
		assert.deepEqual(runInRequestLane(PARENT, () => __testGetBridgeIntegrityState().sharedSession), record);
	});

	it("aborts a cacheRetention:none request while the parent waits on a tool", { timeout: 5000 }, async () => {
		// arrange
		await startParentToolTurn();
		const abort = new AbortController();
		const answer = collect(streamNormalized(model, { messages: [userMessage("hang")] }, { sessionId: PARENT, cacheRetention: "none", signal: abort.signal, cwd: root }));
		assert.equal(await waitFor(() => queries.has("hang")), true, "the one-shot's query started");

		// act
		abort.abort();

		// assert
		assert.deepEqual(errorReasons(await answer), ["aborted"]);
		assert.ok(runInRequestLane(PARENT, () => ctx().activeQuery), "the parent query keeps running");
	});

	it("refuses a request that arrives while the running query's stream is still open", { timeout: 5000 }, async () => {
		// arrange
		const parent = collect(streamNormalized(model, { messages: [userMessage("streaming")] }, { sessionId: PARENT, cwd: root }));
		assert.equal(await waitFor(() => queries.has("streaming")), true, "the parent query started");
		const parentStream = runInRequestLane(PARENT, () => ctx().currentPiStream);

		// act
		const foreign = await collect(streamNormalized(model, { messages: [userMessage("foreign")] }, { sessionId: PARENT, cwd: root }));

		// assert
		assert.deepEqual(errorReasons(foreign), ["error"]);
		assert.match(foreign.at(-1).error.errorMessage, /response stream is still open/);
		assert.equal(runInRequestLane(PARENT, () => ctx().currentPiStream), parentStream);
		assert.deepEqual(runInRequestLane(PARENT, () => ctx().deferredUserMessages), []);

		// act
		queries.get("streaming").gate.resolve();

		// assert
		const parentEvents = await parent;
		assert.deepEqual(textDeltas(parentEvents), ["partial"]);
		assert.equal(parentEvents.at(-1).type, "done");
	});

	it("ends a callback's stream when its own signal, not the query's, aborts", { timeout: 5000 }, async () => {
		// arrange
		const parentAbort = new AbortController();
		await startParentToolTurn(parentAbort.signal);
		const foreignAbort = new AbortController();
		const foreign = collect(streamNormalized(model, { messages: [userMessage("foreign")] }, { sessionId: PARENT, signal: foreignAbort.signal, cwd: root }));

		// act
		foreignAbort.abort();

		// assert
		assert.deepEqual(errorReasons(await foreign), ["aborted"]);
		assert.equal(parentAbort.signal.aborted, false);
		assert.ok(runInRequestLane(PARENT, () => ctx().activeQuery), "the parent query keeps running");
		assert.equal(runInRequestLane(PARENT, () => ctx().currentPiStream), null);
	});
});

function fakeSdk({ prompt, options }) {
	const label = String(prompt);
	const gate = Promise.withResolvers();
	queries.set(label, { options, gate });
	if (label === "parent") server = options.mcpServers["custom-tools"].instance;
	let closed = false;
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: "system", subtype: "init", session_id: `sdk-${label}` };
			if (label === "parent") yield* toolUseTurn();
			if (label === "streaming") yield* streamedText("partial");
			if (!WAITING_PROMPTS.has(label)) yield* streamedText(`answer-${label}`);
			if (WAITING_PROMPTS.has(label)) await gate.promise;
			if (closed) return;
			yield { type: "result", subtype: "success", result: `done-${label}` };
		},
		close() { closed = true; gate.resolve(); },
		async interrupt() { closed = true; gate.resolve(); },
	};
}

function* toolUseTurn() {
	yield { type: "stream_event", event: { type: "message_start", message: { id: "m-parent", model: model.id, usage: { input_tokens: 1 } } } };
	yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-parent", name: "mcp__custom-tools__mytool", input: {} } } };
	yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
	yield { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } } };
	yield { type: "stream_event", event: { type: "message_stop" } };
}

function* streamedText(text) {
	yield { type: "stream_event", event: { type: "message_start", message: { model: model.id, usage: { input_tokens: 1 } } } };
	yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } };
	yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } };
}

async function startParentToolTurn(signal) {
	const events = await collect(streamNormalized(model, { messages: [userMessage("parent")], tools: [tool] }, { sessionId: PARENT, signal, cwd: root }));
	assert.ok(events.some((event) => event.type === "done" && event.reason === "toolUse"), "the parent reached its tool turn");
}

/** Calls the parent's MCP tool the way Claude Code would and returns the
 *  call's promise once the bridge's handler is waiting for Pi's result. The
 *  promise is wrapped so that awaiting this function does not await the call. */
async function callParentTool() {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "one-shot-lane-test", version: "1.0.0" });
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	cleanups.push(() => client.close(), () => server.close());
	const pendingCall = client.callTool({ name: "mytool", arguments: {} });
	assert.equal(await waitFor(() => runInRequestLane(PARENT, () => ctx().pendingToolCalls.has("call-parent"))), true, "the parent's MCP handler is waiting");
	return { pendingCall };
}

function toolLoopContext() {
	return {
		tools: [tool],
		messages: [
			userMessage("parent"),
			{ role: "assistant", content: [{ type: "toolCall", id: "call-parent", name: "mytool", arguments: {} }], timestamp: Date.now() },
			{ role: "toolResult", toolCallId: "call-parent", toolName: "mytool", content: [{ type: "text", text: "parent-output" }], isError: false, timestamp: Date.now() },
		],
	};
}

function parentState() {
	return runInRequestLane(PARENT, () => ({
		activeQuery: ctx().activeQuery,
		currentPiStream: ctx().currentPiStream,
		deferredUserMessages: [...ctx().deferredUserMessages],
		latestCursor: ctx().latestCursor,
		sharedSession: __testGetBridgeIntegrityState().sharedSession,
	}));
}

async function collect(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

const textDeltas = (events) => events.filter((event) => event.type === "text_delta").map((event) => event.delta);
const errorReasons = (events) => events.filter((event) => event.type === "error").map((event) => event.reason);
