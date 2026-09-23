/**
 * The provider driven with a pi 0.86+ transcript: the tool set and the system
 * prompt arrive as system messages, and the persisted cursor counts
 * conversation messages only (see src/transcript.ts).
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";

import {
	__testGetBridgeIntegrityState,
	__testSetBridgeIntegrityState,
	__testSetSdkQueryFactory,
	resolveMcpTools,
	streamClaudeAgentSdk,
} from "../src/index.ts";
import { setExtensionApi } from "../src/bridge-state.ts";
import { resetStack } from "../src/query-state.ts";
import { runInRequestLane } from "../src/request-lane.ts";
import { fakeSdkQuery } from "./lib/fake-sdk-query.mjs";

const model = {
	id: "claude-haiku-4-5",
	name: "Claude Haiku",
	api: "claude-bridge",
	provider: "pi-claude",
	baseUrl: "claude-bridge",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};

async function collect(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

beforeEach(() => {
	process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "0";
	process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: { notify() {} } });
	setExtensionApi({ events: { emit() {} }, appendEntry() {} });
});

afterEach(() => {
	delete process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT;
	delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
	__testSetSdkQueryFactory();
	setExtensionApi(undefined);
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
});

describe("a pi 0.87 transcript", () => {
	it("supplies the tools, the skills block and a conversation-only cursor", async () => {
		// arrange: prompt sections and the initial tool in the leading system
		// message, a second tool added mid-conversation, then the user turn
		const read = { name: "read", description: "read", parameters: { type: "object" } };
		const bash = { name: "bash", description: "bash", parameters: { type: "object" } };
		const skills = "<skills>\nThe following skills provide specialized instructions for specific tasks.\n<available_skills>\n</available_skills>\n</skills>";
		const messages = [
			{ role: "system", content: "", sections: { preamble: "You are pi.", skills }, toolsAdded: [read], timestamp: 0 },
			{ role: "system", content: "", toolsAdded: [bash], timestamp: 1 },
			{ role: "user", content: "hello", timestamp: 2 },
		];
		const transcript = normalizeContext({ messages });
		let queryOptions;
		__testSetSdkQueryFactory((input) => {
			queryOptions = input.options;
			return fakeSdkQuery([
				{ type: "system", subtype: "init", session_id: "transcript-session" },
				{ type: "result", subtype: "success", result: "hi" },
			], "legacy", { usageProbes: [] });
		});

		// act
		await collect(streamClaudeAgentSdk(model, transcript, { sessionId: "transcript" }));

		// assert
		assert.deepEqual(resolveMcpTools(transcript).mcpTools.map((tool) => tool.name), ["read", "bash"]);
		assert.ok(queryOptions.systemPrompt.append.includes("</available_skills>"), "skills block forwarded from the rendered prompt");
		const record = runInRequestLane("transcript", () => __testGetBridgeIntegrityState().sharedSession);
		assert.equal(record.cursor, 1, "cursor counts the one conversation message, not the three transcript messages");
	});
});
