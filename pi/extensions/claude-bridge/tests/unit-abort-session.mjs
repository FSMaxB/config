/**
 * An aborted query interrupts its Claude Code child and waits for it to exit
 * before deciding what happens to the session record: a clean interruption
 * keeps the record so the next turn resumes (prompt cache stays warm), anything
 * else rebuilds, and only an unconfirmed exit rotates the session id.
 */
import "./lib/debug-env.mjs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createSession } from "cc-session-io";
import {
	__testGetBridgeIntegrityState,
	__testSetAbortExitGraceMs,
	__testSetBridgeIntegrityState,
	__testSetSdkQueryFactory,
	__testSetSpawnClaudeCodeProcess,
} from "../src/index.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { ctx, resetStack } from "../src/query-state.ts";
import { conversationFingerprint, conversationFingerprintsMatch } from "../src/session-persistence.ts";
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
let claudeConfigDir;
let previousClaudeConfigDir;

beforeEach(() => {
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
	process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
	diagnosticDir = mkdtempSync(join(tmpdir(), "bridge-abort-diag-"));
	process.env.CLAUDE_BRIDGE_DIAG_PATH = join(diagnosticDir, "diag.log");
	root = mkdtempSync(join(tmpdir(), "bridge-abort-cwd-"));
	claudeConfigDir = mkdtempSync(join(tmpdir(), "bridge-abort-claude-"));
	previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
	process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
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
	rmSync(claudeConfigDir, { recursive: true, force: true });
	if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
	else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
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
		const spawned = [];
		__testSetSpawnClaudeCodeProcess(() => child);
		__testSetSdkQueryFactory((input) => {
			const query = textQuery(input, child, "exits-on-interrupt");
			spawned.push(query);
			return query;
		});
		let closedWhenChildExited;
		child.once("exit", () => { closedWhenChildExited = spawned[0].closed; });
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
		assert.equal(closedWhenChildExited, false, "the child exited on its own, it was not killed");
		const record = laneRecord();
		assert.equal(record.sessionId, "sdk-session");
		assert.equal(record.cursor, 1);
		assert.equal(record.cwd, root);
		assert.equal(record.needsRebuild, undefined);
		assert.equal(record.forceRotate, undefined);
		assert.equal(record.rebuildReason, undefined);
	});

	it("a child that ignores the interrupt is killed after the grace and the session rebuilds", async () => {
		// arrange
		const child = new FakeChild();
		__testSetSpawnClaudeCodeProcess(() => child);
		__testSetSdkQueryFactory((input) => textQuery(input, child, "exits-on-close"));
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
		assert.equal(record.forceRotate, undefined);
		assert.equal(record.rebuildReason, "abort: Claude Code ignored the interrupt and was killed");
	});

	it("a child still running after the grace forces a rebuild with a rotated id", async () => {
		// arrange
		const child = new FakeChild();
		__testSetSpawnClaudeCodeProcess(() => child);
		__testSetSdkQueryFactory((input) => textQuery(input, child, "stays-running"));
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

	it("an abort with a tool call in flight keeps the session when Claude Code recorded the rejection", async () => {
		// arrange
		const child = new FakeChild();
		__testSetSpawnClaudeCodeProcess(() => child);
		__testSetSdkQueryFactory((input) => toolUseQuery(input, child, "exits-on-interrupt"));
		runInRequestLane(LANE, () => __testSetBridgeIntegrityState({ sharedSession: { sessionId: "before", cursor: 1, cwd: root } }));
		writeInterruptedTranscript(root, { paired: true });
		const abort = new AbortController();

		// act
		await consume(streamNormalized(model, toolContext(), { sessionId: LANE, signal: abort.signal, cwd: root }), []);
		assert.ok(runInRequestLane(LANE, () => ctx().activeQuery), "the query is mid tool call");
		abort.abort();
		assert.equal(await waitFor(() => runInRequestLane(LANE, () => ctx().activeQuery === null)), true, "teardown completed");

		// assert
		const record = laneRecord();
		assert.equal(record.sessionId, "sdk-session");
		assert.equal(record.needsRebuild, undefined);
		assert.equal(record.forceRotate, undefined);
		assert.deepEqual(record.interruptedToolCallIds, ["call-1"]);
	});

	it("an abort anchors the kept record on the context of the latest callback", async () => {
		// arrange
		// A context handler prepends a request-local message during turn one
		// (superpowers' bootstrap), which Pi never persists: the anchor the query
		// start computed names an opener the next turn's context will not have.
		// The callback that delivered the tool result saw the first assistant
		// message, and that one is persisted, so the record must anchor on it.
		const child = new FakeChild();
		__testSetSpawnClaudeCodeProcess(() => child);
		__testSetSdkQueryFactory((input) => toolUseQuery(input, child, "exits-on-interrupt"));
		writeInterruptedTranscript(root, { paired: true });
		const abort = new AbortController();
		const bootstrap = userMessage("request-local bootstrap");
		const opener = userMessage("hello");
		const assistantCall = { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "mytool", arguments: {} }], stopReason: "toolUse", timestamp: Date.now() };
		const toolResult = { role: "toolResult", toolCallId: "call-1", toolName: "mytool", content: [{ type: "text", text: "ok" }], timestamp: Date.now() };
		const tools = toolContext().tools;

		// act
		await consume(streamNormalized(model, { tools, messages: [bootstrap, opener] }, { sessionId: LANE, signal: abort.signal, cwd: root }), []);
		const delivery = consume(streamNormalized(model, { tools, messages: [bootstrap, opener, assistantCall, toolResult] }, { sessionId: LANE, signal: abort.signal, cwd: root }), []);
		abort.abort();
		await delivery;
		assert.equal(await waitFor(() => runInRequestLane(LANE, () => ctx().activeQuery === null)), true, "teardown completed");

		// assert
		const record = laneRecord();
		assert.equal(record.sessionId, "sdk-session");
		assert.equal(record.needsRebuild, undefined);
		assert.equal(record.conversationFingerprint, conversationFingerprint([bootstrap, opener, assistantCall, toolResult]));
		const nextTurn = conversationFingerprint([opener, assistantCall, toolResult, userMessage("next turn")]);
		assert.equal(conversationFingerprintsMatch(record.conversationFingerprint, nextTurn), true, "the next turn without the bootstrap is the same conversation");
	});

	it("an abort with a tool call in flight rebuilds when the transcript lacks the result", async () => {
		// arrange
		const child = new FakeChild();
		__testSetSpawnClaudeCodeProcess(() => child);
		__testSetSdkQueryFactory((input) => toolUseQuery(input, child, "exits-on-interrupt"));
		runInRequestLane(LANE, () => __testSetBridgeIntegrityState({ sharedSession: { sessionId: "before", cursor: 1, cwd: root } }));
		writeInterruptedTranscript(root, { paired: false });
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
		assert.equal(record.rebuildReason, "abort with a tool call in flight whose result Claude Code did not record");
	});

	it("a signal already aborted at query start kills the query", async () => {
		// arrange
		const child = new FakeChild();
		const spawned = [];
		__testSetSpawnClaudeCodeProcess(() => child);
		__testSetSdkQueryFactory((input) => {
			const query = textQuery(input, child, "exits-on-close");
			spawned.push(query);
			return query;
		});
		const abort = new AbortController();
		abort.abort();
		const events = [];

		// act
		await consume(streamNormalized(model, { messages: [userMessage("hello")] }, { sessionId: LANE, signal: abort.signal, cwd: root }), events);
		assert.equal(await waitFor(() => runInRequestLane(LANE, () => ctx().activeQuery === null)), true, "teardown completed");

		// assert
		assert.deepEqual(events.filter((event) => event.type === "error").map((event) => event.reason), ["aborted"]);
		assert.equal(spawned[0].closed, true);
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
 *  stays open until the CLI stops. `behavior` is what a real child does: exit on
 *  the interrupt, ignore it and exit once its stdin is closed, or keep running. */
function textQuery({ options }, child, behavior) {
	options.spawnClaudeCodeProcess({ command: "claude", args: [], cwd: "/", env: {} });
	const gate = Promise.withResolvers();
	const query = cliControls(child, behavior, gate);
	query[Symbol.asyncIterator] = async function* () {
		yield { type: "system", subtype: "init", session_id: "sdk-session" };
		yield* streamedText("partial answer");
		await gate.promise;
		if (query.interrupted) throw interruptedTurnError();
	};
	return query;
}

/** Like textQuery but the turn ends in a tool_use, so the abort hits a waiting
 *  tool call. */
function toolUseQuery({ options }, child, behavior) {
	options.spawnClaudeCodeProcess({ command: "claude", args: [], cwd: "/", env: {} });
	const gate = Promise.withResolvers();
	const query = cliControls(child, behavior, gate);
	query[Symbol.asyncIterator] = async function* () {
		yield { type: "system", subtype: "init", session_id: "sdk-session" };
		yield { type: "stream_event", event: { type: "message_start", message: { id: "m1", model: model.id, usage: { input_tokens: 1 } } } };
		yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-1", name: "mcp__custom-tools__mytool", input: {} } } };
		yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
		yield { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } } };
		yield { type: "stream_event", event: { type: "message_stop" } };
		await gate.promise;
		if (query.interrupted) throw interruptedTurnError();
	};
	return query;
}

function cliControls(child, behavior, gate) {
	return {
		closed: false,
		interrupted: false,
		async interrupt() {
			if (behavior !== "exits-on-interrupt") return;
			this.interrupted = true;
			gate.resolve();
			child.exit(1);
		},
		close() {
			this.closed = true;
			gate.resolve();
			if (behavior === "exits-on-close") child.exit(0);
		},
	};
}

/** What the SDK generator throws after the CLI's error result for an interrupted turn. */
function interruptedTurnError() {
	return new Error("Claude Code returned an error result: [ede_diagnostic] interrupted");
}

/** The transcript an interrupted Claude Code child leaves behind: the tool
 *  call Pi was executing, paired with the CLI's rejected result. */
function writeInterruptedTranscript(cwd, { paired }) {
	const session = createSession({ sessionId: "sdk-session", projectPath: cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR });
	session.addUserMessage("hello");
	session.addAssistantMessage([{ type: "tool_use", id: "call-1", name: "mcp__custom-tools__mytool", input: {} }], { stopReason: "tool_use" });
	if (paired) session.addToolResults([{ toolUseId: "call-1", content: "The user doesn't want to proceed with this tool use.", isError: true }]);
	session.save();
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
