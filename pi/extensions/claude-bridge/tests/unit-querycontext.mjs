/**
 * Tests for QueryContext class and context stack infrastructure.
 * Exercises isolation, guards, deferred message merging, and context pinning
 * using the real module — no API calls, no extension activation.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { currentQueryContext, resetStack } from "../src/query-state.js";

const fakeModel = { api: "anthropic", provider: "anthropic", id: "test-model" };

describe("QueryContext class", () => {
	beforeEach(() => resetStack());

	it("turnBlocks throws before resetTurnState", () => {
		assert.throws(() => currentQueryContext().turnBlocks, (error) => error.message.split("\n")[0] === "turn-state-uninitialized=turnBlocks");
	});

	it("turnBlocks reflects turnOutput.content after resetTurnState", () => {
		currentQueryContext().resetTurnState(fakeModel);
		assert.ok(Array.isArray(currentQueryContext().turnBlocks));
		assert.strictEqual(currentQueryContext().turnBlocks.length, 0);

		currentQueryContext().turnBlocks.push({ type: "text", text: "hello" });
		assert.strictEqual(currentQueryContext().turnOutput.content.length, 1);
		assert.strictEqual(currentQueryContext().turnOutput.content[0].text, "hello");
		// Same array reference
		assert.strictEqual(currentQueryContext().turnBlocks, currentQueryContext().turnOutput.content);
	});

	it("resetTurnState preserves active tool tracking across result-delivery callbacks", () => {
		currentQueryContext().turnToolCallIds = ["id1", "id2"];
		currentQueryContext().recordToolCall("id1", "read", { path: "a" });
		currentQueryContext().markToolResultDelivered("id1");
		currentQueryContext().resetTurnState(fakeModel);

		assert.deepStrictEqual(currentQueryContext().turnToolCallIds, ["id1", "id2"]);
		assert.deepStrictEqual(currentQueryContext().turnToolCalls.map((call) => call.id), ["id1"]);
		assert.ok(currentQueryContext().deliveredToolResultIds.has("id1"));
	});

	it("resetToolTracking clears tool-call matching state for a new assistant message", () => {
		currentQueryContext().recordToolCall("id1", "read", { path: "a" });
		currentQueryContext().markToolResultDelivered("id1");
		currentQueryContext().markToolResultResolved("id1");
		currentQueryContext().resetToolTracking();

		assert.deepStrictEqual(currentQueryContext().turnToolCallIds, []);
		assert.deepStrictEqual(currentQueryContext().turnToolCalls, []);
		assert.strictEqual(currentQueryContext().deliveredToolResultIds.size, 0);
		assert.strictEqual(currentQueryContext().resolvedToolResultIds.size, 0);
	});

	it("claimToolCall matches handler invocation by tool name and args, not stream position", () => {
		currentQueryContext().recordToolCall("call-read", "read", { path: "a.txt" });
		currentQueryContext().recordToolCall("call-grep", "grep", { pattern: "needle", path: "src" });

		const second = currentQueryContext().claimToolCall("grep", { path: "src", pattern: "needle" });
		assert.equal(second.toolCallId, "call-grep");
		assert.equal(second.match, "tool-args");

		const first = currentQueryContext().claimToolCall("read", { path: "a.txt" });
		assert.equal(first.toolCallId, "call-read");
		assert.equal(first.match, "tool-args");
	});

	it("claimToolCall handles same-tool parallel calls invoked out of stream order", () => {
		currentQueryContext().recordToolCall("read-a", "read", { path: "a.txt" });
		currentQueryContext().recordToolCall("read-b", "read", { path: "b.txt" });
		currentQueryContext().recordToolCall("grep-src", "grep", { path: "src", pattern: "needle" });
		currentQueryContext().recordToolCall("grep-tests", "grep", { path: "tests", pattern: "needle" });

		const readSecond = currentQueryContext().claimToolCall("read", { path: "b.txt" });
		const grepSecond = currentQueryContext().claimToolCall("grep", { pattern: "needle", path: "tests" });
		const readFirst = currentQueryContext().claimToolCall("read", { path: "a.txt" });
		const grepFirst = currentQueryContext().claimToolCall("grep", { path: "src", pattern: "needle" });

		assert.equal(readSecond.toolCallId, "read-b");
		assert.equal(grepSecond.toolCallId, "grep-tests");
		assert.equal(readFirst.toolCallId, "read-a");
		assert.equal(grepFirst.toolCallId, "grep-src");
		for (const claim of [readSecond, grepSecond, readFirst, grepFirst]) {
			assert.equal(claim.match, "tool-args");
			assert.equal(claim.ambiguous, false);
		}
	});

	it("claimToolCall refuses to fall back to a different tool type", () => {
		currentQueryContext().recordToolCall("bash-1", "bash", { command: "echo ok", timeout: 120 });

		const claim = currentQueryContext().claimToolCall("write", { path: "out.txt", content: "ok" });

		assert.equal(claim.toolCallId, undefined);
		assert.equal(claim.match, "none");
		assert.equal(claim.available, 1);
		assert.equal(currentQueryContext().claimedToolCallIds.has("bash-1"), false);
	});

	it("claimToolCall allows sole same-name call before arguments finalize", () => {
		currentQueryContext().recordToolCall("read-pending", "read", {});

		const claim = currentQueryContext().claimToolCall("read", { path: "README.md" });

		assert.equal(claim.toolCallId, "read-pending");
		assert.equal(claim.match, "tool-name");
		assert.equal(claim.ambiguous, false);
	});

	it("claimToolCall claims the sole same-name call even when recorded args diverge", () => {
		// Recorded args = raw streamed input; handler args = the raw MCP arguments too.
		// A stray/extra key must not strand the only call this handler can be (the
		// argsMismatch fallback now guards against future schema/validator drift).
		currentQueryContext().recordToolCall("edit-1", "edit", { path: "a.ts", edits: [{ oldText: "x", newText: "y", stray: true }] });

		const claim = currentQueryContext().claimToolCall("edit", { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] });

		assert.equal(claim.toolCallId, "edit-1");
		assert.equal(claim.match, "tool-name");
		assert.equal(claim.argsMismatch, true);
		assert.equal(currentQueryContext().claimedToolCallIds.has("edit-1"), true);
	});

	it("claimToolCall still refuses when several same-name calls all mismatch", () => {
		currentQueryContext().recordToolCall("edit-a", "edit", { path: "a.ts", edits: [] });
		currentQueryContext().recordToolCall("edit-b", "edit", { path: "b.ts", edits: [] });

		const claim = currentQueryContext().claimToolCall("edit", { path: "c.ts", edits: [] });

		assert.equal(claim.toolCallId, undefined);
		assert.equal(claim.match, "none");
		assert.equal(claim.available, 2);
	});

	it("takeStaleQueuedResults drains the queue and names tools across message resets", () => {
		currentQueryContext().recordToolCall("bash-lost", "bash", { command: "echo hi", timeout: 120 });
		currentQueryContext().pendingResults.set("bash-lost", { content: [{ type: "text", text: "hi" }] });
		currentQueryContext().resetToolTracking(); // per-message records are cleared at a child-message boundary

		const progress = currentQueryContext().toolResultProgress();
		assert.equal(progress.queuedCount, 1);
		assert.deepEqual(progress.toolNames, [{ name: "bash", count: 1 }], "query-scoped names survive the reset");

		const stale = currentQueryContext().takeStaleQueuedResults();
		assert.deepEqual(stale, [{ id: "bash-lost", toolName: "bash" }]);
		assert.equal(currentQueryContext().pendingResults.size, 0);
		assert.deepEqual(currentQueryContext().takeStaleQueuedResults(), [], "second drain is empty");
	});

	it("toolResultProgress reports teardown mismatch counts", () => {
		currentQueryContext().recordToolCall("t0", "read", { path: "a" });
		currentQueryContext().recordToolCall("t1", "grep", { pattern: "x" });
		currentQueryContext().markToolResultDelivered("t0");
		currentQueryContext().markToolResultResolved("t0");
		currentQueryContext().pendingResults.set("t1", { toolCallId: "t1", content: [{ type: "text", text: "queued" }] });
		currentQueryContext().markToolResultDelivered("t1");

		const progress = currentQueryContext().toolResultProgress();
		assert.equal(progress.expectedCount, 2);
		assert.equal(progress.deliveredCount, 2);
		assert.equal(progress.resolvedCount, 1);
		assert.deepStrictEqual(progress.queuedIds, ["t1"]);
		assert.deepStrictEqual(progress.unresolvedIds, ["t1"]);
		assert.deepStrictEqual(progress.toolNames, [{ name: "grep", count: 1 }]);
	});

	it("toolResultProgress reports unmatched result ids", () => {
		currentQueryContext().recordToolCall("t0", "read", { path: "a" });
		currentQueryContext().markToolResultUnmatched("unknown-result");

		const progress = currentQueryContext().toolResultProgress();

		assert.deepStrictEqual(progress.unmatchedResultIds, ["unknown-result"]);
		assert.equal(progress.unmatchedResultCount, 1);
	});
});
