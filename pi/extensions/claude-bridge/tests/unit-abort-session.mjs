/**
 * An aborted query waits for its killed Claude Code child before deciding what
 * happens to the session record: a clean interruption keeps the record so the
 * next turn resumes (prompt cache stays warm), anything else rebuilds, and only
 * an unconfirmed exit rotates the session id.
 */
import "./lib/debug-env.mjs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	__testGetBridgeIntegrityState,
	__testSetAbortExitGraceMs,
	__testSetBridgeIntegrityState,
	__testSetSdkQueryFactory,
	__testSetSpawnClaudeCodeProcess,
} from "../src/index.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { ctx, resetStack } from "../src/query-state.ts";
import { runInRequestLane } from "../src/request-lane.ts";
import { streamNormalized } from "./lib/stream-normalized.mjs";
import { waitFor } from "./lib/wait-for.mjs";

const model = {
	id: "claude-haiku-4-5", name: "Claude Haiku", api: "claude-bridge", provider: "pi-claude", baseUrl: "claude-bridge",
	reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000, maxTokens: 8192,
};
const LANE = "lane";
const userMessage = (text) => ({ role: "user", content: text, timestamp: Date.now() });
const toolContext = () => ({ tools: [{ name: "mytool", description: "", parameters: { type: "object" } }], messages: [userMessage("hello")] });

let root;
let diagnosticDir;

beforeEach(() => {
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
	process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
	diagnosticDir = mkdtempSync(join(tmpdir(), "bridge-abort-diag-"));
	process.env.CLAUDE_BRIDGE_DIAG_PATH = join(diagnosticDir, "diag.log");
	root = mkdtempSync(join(tmpdir(), "bridge-abort-cwd-"));
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify: () => {} } });
	setExtensionApi({ events: { emit: () => {} }, appendEntry: () => {} });
});
afterEach(() => {
	delete process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT;
	delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
	delete process.env.CLAUDE_BRIDGE_DIAG_PATH;
	rmSync(diagnosticDir, { recursive: true, force: true });
	rmSync(root, { recursive: true, force: true });
	__testSetSdkQueryFactory();
	__testSetSpawnClaudeCodeProcess();
	__testSetAbortExitGraceMs();
	setExtensionApi(undefined);
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
});

describe("aborted query settlement", () => {
	it("a clean abort keeps the Claude session for the next turn", async () => {
		// arrange
		const child = new FakeChild();
		__testSetSpawnClaudeCodeProcess(() => child);
		__testSetSdkQueryFactory((input) => textQuery(input, child, "exit-on-close"));
		const abort = new AbortController();
		const events = [];

		// act
		const consumer = consume(streamNormalized(model, { messages: [userMessage("hello")] }, { sessionId: LANE, signal: abort.signal, cwd: root }), events);
		assert.equal(await waitFor(() => events.some((event) => event.type === "text_delta")), true, "the turn started streaming");
		abort.abort();
		await consumer;
		assert.equal(await waitFor(() => runInRequestLane(LANE, () => ctx().activeQuery === null)), true, "teardown completed");

		// assert
		const aborted = events.filter((event) => event.type === "error");
		assert.deepEqual(aborted.map((event) => event.reason), ["aborted"]);
		const record = laneRecord();
		assert.equal(record.sessionId, "sdk-session");
		assert.equal(record.cursor, 1);
		assert.equal(record.cwd, root);
		assert.equal(record.needsRebuild, undefined);
		assert.equal(record.forceRotate, undefined);
		assert.equal(record.rebuildReason, undefined);
	});

	it("a child still running after the grace forces a rebuild with a rotated id", async () => {
		// arrange
		const child = new FakeChild();
		__testSetSpawnClaudeCodeProcess(() => child);
		__testSetSdkQueryFactory((input) => textQuery(input, child, "stay-running"));
		__testSetAbortExitGraceMs(50);
		runInRequestLane(LANE, () => __testSetBridgeIntegrityState({ sharedSession: { sessionId: "before", cursor: 1, cwd: root } }));
		const abort = new AbortController();
		const events = [];

		// act
		const consumer = consume(streamNormalized(model, { messages: [userMessage("hello")] }, { sessionId: LANE, signal: abort.signal, cwd: root }), events);
		assert.equal(await waitFor(() => events.some((event) => event.type === "text_delta")), true, "the turn started streaming");
		abort.abort();
		await consumer;
		assert.equal(await waitFor(() => runInRequestLane(LANE, () => ctx().activeQuery === null)), true, "teardown completed");

		// assert
		const record = laneRecord();
		assert.equal(record.sessionId, "before");
		assert.equal(record.needsRebuild, true);
		assert.equal(record.forceRotate, true);
		assert.equal(record.rebuildReason, "abort while the Claude Code process was still running");
	});

	it("an abort with a tool call in flight rebuilds without rotating once the child exited", async () => {
		// arrange
		const child = new FakeChild();
		__testSetSpawnClaudeCodeProcess(() => child);
		__testSetSdkQueryFactory((input) => toolUseQuery(input, child, "exit-on-close"));
		runInRequestLane(LANE, () => __testSetBridgeIntegrityState({ sharedSession: { sessionId: "before", cursor: 1, cwd: root } }));
		const abort = new AbortController();

		// act
		await consume(streamNormalized(model, toolContext(), { sessionId: LANE, signal: abort.signal, cwd: root }), []);
		assert.ok(runInRequestLane(LANE, () => ctx().activeQuery), "the query is mid tool call");
		abort.abort();
		assert.equal(await waitFor(() => runInRequestLane(LANE, () => ctx().activeQuery === null)), true, "teardown completed");

		// assert
		const record = laneRecord();
		assert.equal(record.needsRebuild, true);
		assert.equal(record.forceRotate, undefined);
		assert.equal(record.rebuildReason, "abort with a tool call in flight");
	});
});

/** What the SDK sees from spawnClaudeCodeProcess; the test decides when it exits. */
class FakeChild extends EventEmitter {
	stdin = new PassThrough();
	stdout = new PassThrough();
	killed = false;
	exitCode = null;
	signalCode = null;

	kill() {
		this.killed = true;
		return true;
	}

	exit(code = 0) {
		this.exitCode = code;
		this.emit("exit", code, null);
	}
}

/** A query that spawns `child` the way the SDK does, streams some text and then
 *  stays open until it is closed. `exitBehavior` is what a real child does when
 *  its stdin is destroyed: exit, or keep running. */
function textQuery({ options }, child, exitBehavior) {
	options.spawnClaudeCodeProcess({ command: "claude", args: [], cwd: "/", env: {} });
	const gate = Promise.withResolvers();
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: "system", subtype: "init", session_id: "sdk-session" };
			yield* streamedText("partial answer");
			await gate.promise;
		},
		close() {
			gate.resolve();
			if (exitBehavior === "exit-on-close") child.exit(0);
		},
		async interrupt() {},
	};
}

/** Like textQuery but the turn ends in a tool_use, so the abort hits a waiting
 *  tool call. */
function toolUseQuery({ options }, child, exitBehavior) {
	options.spawnClaudeCodeProcess({ command: "claude", args: [], cwd: "/", env: {} });
	const gate = Promise.withResolvers();
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: "system", subtype: "init", session_id: "sdk-session" };
			yield { type: "stream_event", event: { type: "message_start", message: { id: "m1", model: model.id, usage: { input_tokens: 1 } } } };
			yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-1", name: "mcp__custom-tools__mytool", input: {} } } };
			yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
			yield { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } } };
			yield { type: "stream_event", event: { type: "message_stop" } };
			await gate.promise;
		},
		close() {
			gate.resolve();
			if (exitBehavior === "exit-on-close") child.exit(0);
		},
		async interrupt() {},
	};
}

function streamedText(text) {
	return [
		{ type: "stream_event", event: { type: "message_start", message: { model: model.id, usage: { input_tokens: 1 } } } },
		{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
		{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
	];
}

async function consume(stream, events) {
	for await (const event of stream) events.push(event);
}

function laneRecord() {
	return runInRequestLane(LANE, () => __testGetBridgeIntegrityState().sharedSession);
}
