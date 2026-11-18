import { it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { QueryContext, currentQueryContext, drainPendingToolCalls, resetStack, toolCallDrainCause } from "../src/query-state.js";

function registerWaitingCall(queryCtx, toolCallId, toolName = "read") {
	return new Promise((resolve) => {
		queryCtx.pendingToolCalls.set(toolCallId, {
			toolName,
			resolve: (result) => { queryCtx.markToolResultResolved(toolCallId); resolve(result); },
		});
	});
}
beforeEach(() => resetStack());

for (const cause of ["abort", "stream-idle-timeout", "query-end"]) it(`drains with ${cause}`, async () => {
	const waiting = registerWaitingCall(currentQueryContext(), "call-1");
	assert.equal(drainPendingToolCalls(currentQueryContext(), cause), 1);
	const result = await waiting;
	assert.deepEqual([result.isError, result.content[0].type, result.content[0].text.split("\n")[0]], [true, "text", `tool-call-drain=${cause}`]);
	assert.equal(currentQueryContext().pendingToolCalls.size, 0);
	assert.equal(currentQueryContext().resolvedToolResultIds.has("call-1"), true);
});

it("drains every waiting handler and marks each resolved", async () => {
	const first = registerWaitingCall(currentQueryContext(), "call-a", "read");
	const second = registerWaitingCall(currentQueryContext(), "call-b", "grep");
	assert.equal(drainPendingToolCalls(currentQueryContext(), "abort"), 2);
	assert.equal(currentQueryContext().pendingToolCalls.size, 0);
	for (const result of await Promise.all([first, second])) assert.equal(result.isError, true);
	assert.deepEqual([...currentQueryContext().resolvedToolResultIds], ["call-a", "call-b"]);
});
it("does nothing when no handler waits", () => { assert.equal(drainPendingToolCalls(currentQueryContext(), "query-end"), 0); });
it("leaves another query's handlers waiting", async () => {
	const other = new QueryContext();
	let otherResolved = false;
	const otherCall = registerWaitingCall(other, "other-call").then(() => { otherResolved = true; });
	const mine = registerWaitingCall(currentQueryContext(), "my-call");
	try {
		assert.equal(drainPendingToolCalls(currentQueryContext(), "query-end"), 1);
		await mine;
		assert.equal(otherResolved, false);
		assert.equal(other.pendingToolCalls.size, 1);
	} finally { drainPendingToolCalls(other, "query-end"); await otherCall; }
});

const causes = [
	["plain end", {}, "query-end"],
	["false flags", { wasAborted: false, signalAborted: false, streamIdleTimedOut: false }, "query-end"],
	["own abort", { wasAborted: true }, "abort"],
	["Pi abort", { signalAborted: true }, "abort"],
	["idle timeout", { streamIdleTimedOut: true }, "stream-idle-timeout"],
	["own abort precedes timeout", { streamIdleTimedOut: true, wasAborted: true }, "abort"],
	["Pi abort precedes timeout", { streamIdleTimedOut: true, signalAborted: true }, "abort"],
];
for (const [name, flags, expected] of causes) it(name, () => { assert.equal(toolCallDrainCause(flags), expected); });
