import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planIncrementalPromptBatch } from "../src/index.ts";

const msg = (role, toolCallId) => ({ role, content: role === "assistant" ? [] : role, ...(toolCallId ? { toolCallId } : {}) });

describe("planIncrementalPromptBatch", () => {
	it("plans only unclaimed user tails after the cursor", () => {
		// Pi emits follow-up tails and may re-enter with a different context.
		for (const { name, roles, cursor, expected } of [
			{ name: "all follow-ups", roles: ["user", "assistant", "user", "user"], cursor: 1, expected: { promptStart: 2, userMessageCount: 2 } },
			{ name: "single follow-up", roles: ["user", "assistant", "user"], cursor: 1, expected: { promptStart: 2, userMessageCount: 1 } },
			{ name: "cursor past assistant", roles: ["user", "assistant", "user", "user"], cursor: 2, expected: { promptStart: 2, userMessageCount: 2 } },
			{ name: "intervening assistant", roles: ["user", "assistant", "user", "assistant", "user"], cursor: 1, expected: undefined },
			{ name: "non-user final prompt", roles: ["user", "assistant", "toolResult"], cursor: 1, expected: undefined },
			{ name: "tool result in tail", roles: ["user", "assistant", "toolResult", "user"], cursor: 1, expected: undefined },
			{ name: "foreign context cursor", roles: ["user"], cursor: 40, expected: undefined },
			{ name: "already claimed last user", roles: ["user", "assistant", "user"], cursor: 3, expected: undefined },
			{ name: "last-index cursor", roles: ["user", "assistant", "user"], cursor: 2, expected: { promptStart: 2, userMessageCount: 1 } },
		]) {
			assert.deepEqual(planIncrementalPromptBatch(roles.map(msg), cursor), expected, name);
		}
	});
});

describe("planIncrementalPromptBatch with interrupted tool calls", () => {
	it("skips Pi's results for calls the interrupt already settled in Claude's transcript", () => {
		for (const { name, messages, cursor, ids, expected } of [
			{ name: "interrupted tool result in tail", messages: [msg("user"), msg("assistant"), msg("toolResult", "call-1"), msg("user")], cursor: 1, ids: ["call-1"], expected: { promptStart: 3, userMessageCount: 1 } },
			{ name: "two interrupted tool results in tail", messages: [msg("user"), msg("assistant"), msg("toolResult", "call-1"), msg("toolResult", "call-2"), msg("user")], cursor: 1, ids: ["call-1", "call-2"], expected: { promptStart: 4, userMessageCount: 1 } },
			{ name: "unknown tool result in tail", messages: [msg("user"), msg("assistant"), msg("toolResult", "call-9"), msg("user")], cursor: 1, ids: ["call-1"], expected: undefined },
			{ name: "interrupted tool result without a prompt", messages: [msg("user"), msg("assistant"), msg("toolResult", "call-1")], cursor: 1, ids: ["call-1"], expected: undefined },
		]) {
			assert.deepEqual(planIncrementalPromptBatch(messages, cursor, ids), expected, name);
		}
	});
});
