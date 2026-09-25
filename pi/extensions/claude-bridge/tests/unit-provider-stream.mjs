import { fakeSdkQuery } from "./lib/fake-sdk-query.mjs";
import { waitFor } from "./lib/wait-for.mjs";
import "./lib/debug-env.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { __testSetBridgeIntegrityState, __testGetBridgeIntegrityState, __testSetSdkQueryFactory } from "../src/index.ts";
import { streamNormalized } from "./lib/stream-normalized.mjs";
import { RATE_LIMIT_TOKEN } from "../src/rate-limit.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { ctx, resetStack } from "../src/query-state.ts";
import { runInRequestLane } from "../src/request-lane.ts";

const model = {
	id: "claude-haiku-4-5", name: "Claude Haiku", api: "claude-bridge", provider: "pi-claude", baseUrl: "claude-bridge",
	reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000, maxTokens: 8192,
};
const context = { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] };
const routerSymbol = Symbol.for("kendex.pi.claude-account-router.v1");
let notifications;
let emittedRateLimitEvents;
let diagnosticDir;

beforeEach(() => {
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
	process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
	diagnosticDir = mkdtempSync(join(tmpdir(), "bridge-stream-diag-"));
	process.env.CLAUDE_BRIDGE_DIAG_PATH = join(diagnosticDir, "diag.log");
	resetStack();
	notifications = [];
	emittedRateLimitEvents = [];
	__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify: (message, level) => notifications.push({ message, level }) } });
	setExtensionApi({ events: { emit: (name, payload) => emittedRateLimitEvents.push({ name, payload }) }, appendEntry: () => {} });
});
afterEach(() => {
	delete process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT;
	delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
	delete process.env.CLAUDE_BRIDGE_DIAG_PATH;
	delete globalThis[routerSymbol];
	rmSync(diagnosticDir, { recursive: true, force: true });
	__testSetSdkQueryFactory();
	setExtensionApi(undefined);
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
});

describe("ordinary provider stream", () => {
	it("keeps a successful fallback after a rejected rate limit", async () => {
		// arrange
		let calls = 0;
		__testSetSdkQueryFactory(() => {
			calls++;
			return query([
				{ type: "system", subtype: "init", session_id: "session-one" },
				{ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: new Date(Date.now() + 60_000).toISOString() } },
				...streamedText("recovered"),
				{ type: "result", subtype: "success", result: "recovered" },
			]);
		});
		// act
		const events = await collect(streamNormalized(model, context, { sessionId: "ordinary-recovery" }));
		// assert
		assert.equal(calls, 1);
		assert.deepEqual(textEvents(events), ["recovered"]);
		assert.equal(events.filter((event) => event.type === "error").length, 0);
		assert.equal(notifications.filter((notice) => notice.message.includes(RATE_LIMIT_TOKEN)).length, 1);
		assert.equal(emittedRateLimitEvents.length, 1);
		assert.equal(sessionFor("ordinary-recovery")?.sessionId, "session-one");
	});

	it("surfaces usage-limit and other terminal result failures while persisting the session", async () => {
		// arrange
		__testSetSdkQueryFactory(() => query([
			{ type: "system", subtype: "init", session_id: "session-failure" },
			{ type: "result", subtype: "error_during_execution", errors: ["You've hit your weekly limit · resets Thursday 4am"] },
		]));
		// act
		const events = await collect(streamNormalized(model, context, { sessionId: "ordinary-failure" }));
		// assert
		assert.equal(events.filter((event) => event.type === "error").length, 1);
		assert.equal(sessionFor("ordinary-failure")?.sessionId, "session-failure");
	});

	it("ignores a fake global router for model and account selection", async () => {
		// arrange
		let acquisitions = 0;
		globalThis[routerSymbol] = { version: 1, acquire() { acquisitions++; return { profileId: "foreign", modelId: "wrong-model", configDir: "/wrong" }; } };
		let queryOptions;
		__testSetSdkQueryFactory((input) => { queryOptions = input.options; return query([{ type: "result", subtype: "success", result: "answer" }]); });
		// act
		await collect(streamNormalized(model, context, { sessionId: "router-ignored" }));
		// assert
		assert.equal(acquisitions, 0);
		assert.equal(queryOptions.model, model.id);
		assert.equal(queryOptions.env.CLAUDE_CODE_OAUTH_TOKEN, "test-token");
	});

	it("does not let a fake router supply missing credentials", { skip: process.platform === "darwin" }, async () => {
		// arrange
		delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
		let acquisitions = 0;
		let calls = 0;
		globalThis[routerSymbol] = { version: 1, acquire() { acquisitions++; return { profileId: "foreign" }; } };
		__testSetSdkQueryFactory(() => { calls++; return query([]); });
		// act
		const events = await collect(streamNormalized(model, context, { sessionId: "router-without-login" }));
		// assert
		assert.equal(acquisitions, 0);
		assert.equal(calls, 0);
		assert.match(events.find((event) => event.type === "error")?.error.errorMessage ?? "", /claude login/);
	});

	it("never replays deferred input after a terminal failure", async () => {
		// arrange
		let calls = 0;
		__testSetSdkQueryFactory(() => {
			calls++;
			return {
				async *[Symbol.asyncIterator]() {
					ctx().deferredUserMessages.push({ text: "queued steer" });
					yield { type: "system", subtype: "init", session_id: "session-failure" };
					yield { type: "result", subtype: "error_max_turns", errors: ["max turns exceeded"] };
				}, close() {}, async interrupt() {},
			};
		});
		// act
		const events = await collect(streamNormalized(model, context, { sessionId: "deferred-failure" }));
		// assert
		assert.equal(calls, 1);
		assert.equal(events.filter((event) => event.type === "error").length, 1);
		assert.equal(sessionFor("deferred-failure")?.needsRebuild, true);
		const diagnostic = readFileSync(process.env.CLAUDE_BRIDGE_DIAG_PATH, "utf8");
		assert.match(diagnostic, /deferred_user_messages_dropped/);
		assert.doesNotMatch(diagnostic, /queued steer/);
	});

	it("keeps Pi-only tool policy on deferred-input continuations", async () => {
		// arrange
		const options = [];
		__testSetSdkQueryFactory((input) => {
			options.push(input.options);
			if (options.length === 1) {
				return {
					async *[Symbol.asyncIterator]() {
						ctx().deferredUserMessages.push({ text: "later" });
						yield { type: "system", subtype: "init", session_id: "first-session" };
						yield { type: "result", subtype: "success", result: "first" };
					}, close() {}, async interrupt() {}, async accountInfo() { return {}; },
				};
			}
			return query([{ type: "result", subtype: "success", result: "second" }]);
		});
		// act
		await collect(streamNormalized(model, { ...context, tools: [{ name: "read", description: "", parameters: { type: "object" } }] }, { sessionId: "continued-policy" }));
		// assert
		assert.equal(options.length, 2);
		assert.equal(options[1].resume, "first-session");
		for (const queryOptions of options) {
			assert.deepEqual(queryOptions.tools, []);
			assert.deepEqual(queryOptions.allowedTools, ["mcp__custom-tools__*"]);
			assert.equal(queryOptions.strictMcpConfig, true);
			assert.equal(queryOptions.env.ENABLE_CLAUDEAI_MCP_SERVERS, "0");
			assert.deepEqual(Object.keys(queryOptions.mcpServers), ["custom-tools"]);
			const denied = await queryOptions.hooks.PreToolUse[0].hooks[0]({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} });
			assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
		}
		assert.equal(options[1].hooks, options[0].hooks);
	});

	it("forwards a tool-less caller's system prompt verbatim instead of the Claude Code preset", async () => {
		// arrange
		const extractionPrompt = "Return ONLY JSON {\"summary\":string,\"claims\":[]}";
		let queryOptions;
		__testSetSdkQueryFactory((input) => { queryOptions = input.options; return query([{ type: "result", subtype: "success", result: "{}" }]); });
		// act
		await collect(streamNormalized(model, { ...context, systemPrompt: extractionPrompt, tools: [] }, { sessionId: "memory-one-shot", cacheRetention: "none" }));
		// assert
		assert.equal(queryOptions.systemPrompt, extractionPrompt);
		assert.deepEqual(queryOptions.mcpServers, {});
	});

	it("clears transient rebuild flags after a successful query", async () => {
		// arrange
		runInRequestLane("clear-flags", () => __testSetBridgeIntegrityState({ sharedSession: {
			sessionId: "existing-session", cursor: 0, cwd: process.cwd(),
		} }));
		__testSetSdkQueryFactory(() => ({
			async *[Symbol.asyncIterator]() {
				yield { type: "system", subtype: "init", session_id: "successful-session" };
				const shared = __testGetBridgeIntegrityState().sharedSession;
				if (shared) __testSetBridgeIntegrityState({ sharedSession: { ...shared, needsRebuild: true, forceRotate: true } });
				yield { type: "result", subtype: "success", result: "success-clears-flags" };
			}, close() {}, async interrupt() {}, async accountInfo() { return {}; },
		}));
		// act
		const events = await collect(streamNormalized(model, context, { sessionId: "clear-flags" }));
		// assert
		assert.deepEqual(textEvents(events), ["success-clears-flags"]);
		assert.equal(sessionFor("clear-flags")?.sessionId, "successful-session");
		assert.equal(sessionFor("clear-flags")?.needsRebuild, undefined);
		assert.equal(sessionFor("clear-flags")?.forceRotate, undefined);
	});

	it("does not shrink the parent cursor during a reentrant subagent call", async () => {
		// arrange
		const parent = { sessionId: "parent-session", cursor: 40, cwd: "/parent" };
		runInRequestLane("parent", () => __testSetBridgeIntegrityState({ sharedSession: { ...parent } }));
		let release;
		const gate = new Promise((resolve) => { release = resolve; });
		__testSetSdkQueryFactory(() => ({
			async *[Symbol.asyncIterator]() {
				yield { type: "system", subtype: "init", session_id: "parent-live" };
				await gate;
				yield { type: "result", subtype: "success", result: "parent-done" };
			}, close() {}, async interrupt() {},
		}));
		// act
		const parentStream = streamNormalized(model, context, { sessionId: "parent" });
		assert.equal(await waitFor(() => runInRequestLane("parent", () => ctx().activeQuery !== null)), true);
		const subagentStream = streamNormalized(model, { messages: [{ role: "user", content: "", timestamp: Date.now() }] }, { sessionId: "subagent" });
		// assert
		assert.deepEqual(sessionFor("parent"), parent);
		release();
		await Promise.all([collect(parentStream), collect(subagentStream)]);
	});

	it("a short fresh conversation never resumes the parent's long session", async () => {
		// arrange
		runInRequestLane("subagent", () => __testSetBridgeIntegrityState({ sharedSession: { sessionId: "parent-session", cursor: 40, cwd: "/parent" } }));
		let queryOptions;
		__testSetSdkQueryFactory((input) => { queryOptions = input.options; return query([{ type: "result", subtype: "success", result: "subagent-answer" }]); });
		// act
		const events = await collect(streamNormalized(model, { messages: [{ role: "user", content: "subagent prompt", timestamp: Date.now() }] }, { sessionId: "subagent" }));
		// assert
		assert.equal(queryOptions.resume, undefined);
		assert.deepEqual(textEvents(events), ["subagent-answer"]);
	});

	it("surfaces a child transport error after streamed output", async () => {
		// arrange
		__testSetSdkQueryFactory(() => query([
			{ type: "system", subtype: "init", session_id: "transport-session" },
			...streamedText("partial"),
			new Error("socket timeout"),
		]));
		// act
		const events = await collect(streamNormalized(model, context, { sessionId: "post-stream-error" }));
		// assert
		assert.deepEqual(textEvents(events), ["partial"]);
		assert.equal(events.filter((event) => event.type === "error").length, 1);
	});

	it("records a terminal failure after the Pi tool-use stream boundary", async () => {
		// arrange
		__testSetSdkQueryFactory(() => query([
			{ type: "system", subtype: "init", session_id: "session-tool" },
			{ type: "stream_event", event: { type: "message_start", message: { id: "m1", model: model.id, usage: { input_tokens: 1 } } } },
			{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-1", name: "mcp__custom-tools__mytool", input: {} } } },
			{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
			{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } } },
			{ type: "stream_event", event: { type: "message_stop" } },
			{ type: "result", subtype: "error_during_execution", errors: ["internal server error"] },
		]));
		// act
		const withTool = { ...context, tools: [{ name: "mytool", description: "", parameters: { type: "object" } }] };
		const events = await collect(streamNormalized(model, withTool, { sessionId: "post-boundary-failure" }));
		// assert
		assert.ok(events.some((event) => event.type === "done" && event.reason === "toolUse"));
		assert.equal(await waitFor(() => runInRequestLane("post-boundary-failure", () => ctx().activeQuery === null)), true);
		assert.equal(sessionFor("post-boundary-failure")?.sessionId, "session-tool");
	});
});

function query(messages) { return fakeSdkQuery(messages, "ordinary", { usageProbes: [] }); }
function streamedText(text) {
	return [
		{ type: "stream_event", event: { type: "message_start", message: { model: model.id, usage: { input_tokens: 1 } } } },
		{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
		{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
	];
}
async function collect(stream) { const events = []; for await (const event of stream) events.push(event); return events; }
function textEvents(events) { return events.filter((event) => event.type === "text_delta").map((event) => event.delta); }
function sessionFor(sessionId) { return runInRequestLane(sessionId, () => __testGetBridgeIntegrityState().sharedSession); }
