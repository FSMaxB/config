import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { conversationMessages } from "../src/transcript.ts";

describe("conversationMessages", () => {
	it("drops system messages wherever they sit and keeps the rest in order", () => {
		// arrange
		const system = (timestamp) => ({ role: "system", content: "", timestamp });
		const user = { role: "user", content: "hi", timestamp: 1 };
		const assistant = { role: "assistant", content: [], timestamp: 2 };
		const toolResult = { role: "toolResult", toolCallId: "t1", toolName: "read", content: [], isError: false, timestamp: 3 };

		// act
		const result = conversationMessages([system(0), user, system(1), assistant, toolResult, system(4)]);

		// assert
		assert.deepEqual(result, [user, assistant, toolResult]);
	});

	it("returns an empty list for a transcript that only declares a prompt", () => {
		assert.deepEqual(conversationMessages([{ role: "system", content: "prompt", timestamp: 0 }]), []);
	});
});
