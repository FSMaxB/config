import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { currentQueryContext, pushContext, popContext, popContextFor, resetStack, stackDepth } from "../src/query-state.js";

describe("context stack guards", () => {
	beforeEach(() => resetStack());

	it("pushContext throws with no active query", () => {
		assert.throws(() => pushContext(), (error) => error.message.split("\n")[0] === "query-stack-push=inactive");
	});

	it("popContext throws on empty stack", () => {
		assert.throws(() => popContext(), (error) => error.message.split("\n")[0] === "query-stack-pop=empty");
	});
});

describe("stack isolation and restore", () => {
	beforeEach(() => resetStack());

	it("push/pop isolates state and restores parent", () => {
		// Parent setup
		currentQueryContext().activeQuery = { id: "parent" };
		currentQueryContext().pendingToolCalls.set("t1", { toolName: "read", resolve: () => {} });
		currentQueryContext().latestCursor = 42;
		currentQueryContext().deferredUserMessages = ["parent-msg"];

		// Push — child should be clean
		pushContext();
		assert.strictEqual(currentQueryContext().activeQuery, undefined);
		assert.strictEqual(currentQueryContext().pendingToolCalls.size, 0);
		assert.strictEqual(currentQueryContext().pendingResults.size, 0);
		assert.strictEqual(currentQueryContext().latestCursor, 0);
		assert.deepStrictEqual(currentQueryContext().deferredUserMessages, []);

		// Mutate child
		currentQueryContext().activeQuery = { id: "child" };
		currentQueryContext().pendingToolCalls.set("t2", { toolName: "write", resolve: () => {} });
		currentQueryContext().latestCursor = 99;

		// Pop — parent restored
		popContext();
		assert.deepStrictEqual(currentQueryContext().activeQuery, { id: "parent" });
		assert.strictEqual(currentQueryContext().pendingToolCalls.size, 1);
		assert.ok(currentQueryContext().pendingToolCalls.has("t1"));
		assert.strictEqual(currentQueryContext().latestCursor, 42);
	});

	it("deferred messages merge on pop in FIFO order", () => {
		currentQueryContext().activeQuery = { id: "parent" };
		currentQueryContext().deferredUserMessages = ["parent-1", "parent-2"];

		pushContext();
		currentQueryContext().deferredUserMessages = ["child-1", "child-2"];

		popContext();
		assert.deepStrictEqual(
			currentQueryContext().deferredUserMessages,
			["parent-1", "parent-2", "child-1", "child-2"],
		);
	});

	it("triple-nested isolation — each level independent, pop restores", () => {
		// Level 0 (root)
		currentQueryContext().activeQuery = { id: "L0" };
		currentQueryContext().latestCursor = 10;
		currentQueryContext().deferredUserMessages = ["L0-msg"];

		// Level 1
		pushContext();
		assert.strictEqual(stackDepth(), 1);
		currentQueryContext().activeQuery = { id: "L1" };
		currentQueryContext().latestCursor = 20;
		currentQueryContext().deferredUserMessages = ["L1-msg"];

		// Level 2
		pushContext();
		assert.strictEqual(stackDepth(), 2);
		currentQueryContext().activeQuery = { id: "L2" };
		currentQueryContext().latestCursor = 30;
		currentQueryContext().deferredUserMessages = ["L2-msg"];

		// Pop L2 → L1 (L2's deferred merge into L1)
		popContext();
		assert.strictEqual(stackDepth(), 1);
		assert.deepStrictEqual(currentQueryContext().activeQuery, { id: "L1" });
		assert.strictEqual(currentQueryContext().latestCursor, 20);
		assert.deepStrictEqual(currentQueryContext().deferredUserMessages, ["L1-msg", "L2-msg"]);

		// Pop L1 → L0 (L1+L2's deferred merge into L0)
		popContext();
		assert.strictEqual(stackDepth(), 0);
		assert.deepStrictEqual(currentQueryContext().activeQuery, { id: "L0" });
		assert.strictEqual(currentQueryContext().latestCursor, 10);
		assert.deepStrictEqual(currentQueryContext().deferredUserMessages, ["L0-msg", "L1-msg", "L2-msg"]);
	});
});

describe("context pinning (MCP handler closure pattern)", () => {
	beforeEach(() => resetStack());

	it("captured context ref stays valid across push/pop", () => {
		currentQueryContext().activeQuery = { id: "parent" };
		currentQueryContext().pendingToolCalls.set("t1", { toolName: "read", resolve: () => {} });

		// Simulate handler capturing parent context before push
		const capturedCtx = currentQueryContext();

		pushContext();
		// After push, currentQueryContext() is the child — but capturedCtx still points to parent
		assert.notStrictEqual(currentQueryContext(), capturedCtx);
		assert.strictEqual(capturedCtx.pendingToolCalls.size, 1);
		assert.ok(capturedCtx.pendingToolCalls.has("t1"));

		// Mutate child — captured parent unaffected
		currentQueryContext().pendingToolCalls.set("t2", { toolName: "write", resolve: () => {} });
		assert.strictEqual(capturedCtx.pendingToolCalls.size, 1);

		// Pop restores parent as current
		popContext();
		assert.strictEqual(currentQueryContext(), capturedCtx);
	});

	it("captured parent context tracks a parent result while child query is current", () => {
		currentQueryContext().activeQuery = { id: "parent" };
		currentQueryContext().recordToolCall("parent-tool", "read", { path: "parent.txt" });
		const capturedParent = currentQueryContext();

		pushContext();
		currentQueryContext().activeQuery = { id: "child" };
		currentQueryContext().recordToolCall("child-tool", "read", { path: "child.txt" });

		capturedParent.markToolResultDelivered("parent-tool");
		capturedParent.markToolResultResolved("parent-tool");
		const parentProgress = capturedParent.toolResultProgress();
		const childProgress = currentQueryContext().toolResultProgress();

		assert.equal(parentProgress.resolvedCount, 1);
		assert.equal(childProgress.resolvedCount, 0);
		assert.deepStrictEqual(childProgress.missingDeliveredIds, ["child-tool"]);

		popContext();
		assert.strictEqual(currentQueryContext(), capturedParent);
	});
});

describe("popContextFor", () => {
	beforeEach(() => resetStack());

	it("pops normally when the target is the live context", () => {
		const parent = currentQueryContext();
		parent.activeQuery = "q-parent";
		pushContext();
		const child = currentQueryContext();
		child.deferredUserMessages.push({ text: "steer" });

		assert.equal(popContextFor(child), true);
		assert.equal(currentQueryContext(), parent);
		assert.equal(stackDepth(), 0);
		assert.deepEqual(parent.deferredUserMessages, [{ text: "steer" }]);
	});

	it("splices a buried context out of the stack without touching the live child", () => {
		const outer = currentQueryContext();
		outer.activeQuery = "q-outer";
		pushContext();
		const mid = currentQueryContext();
		mid.activeQuery = "q-mid";
		mid.deferredUserMessages.push({ text: "mid-steer" });
		pushContext();
		const grandchild = currentQueryContext();

		// mid is buried under the live grandchild; popping it must not disturb currentQueryContext().
		assert.equal(popContextFor(mid), true);
		assert.equal(currentQueryContext(), grandchild);
		assert.equal(stackDepth(), 1);
		// mid's deferred messages went to ITS parent (outer), not the grandchild.
		assert.deepEqual(outer.deferredUserMessages, [{ text: "mid-steer" }]);
		assert.deepEqual(grandchild.deferredUserMessages, []);

		// The grandchild's own pop now restores the correct grandparent.
		popContext();
		assert.equal(currentQueryContext(), outer);
		assert.equal(stackDepth(), 0);
	});

	it("returns false for a context that is nowhere in the state", () => {
		const parent = currentQueryContext();
		parent.activeQuery = "q";
		pushContext();
		const child = currentQueryContext();
		popContext();

		assert.equal(popContextFor(child), false);
		assert.equal(currentQueryContext(), parent);
	});
});

