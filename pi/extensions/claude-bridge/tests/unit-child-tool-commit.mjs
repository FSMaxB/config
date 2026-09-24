import { it } from "node:test";
import assert from "node:assert/strict";
import { QueryContext } from "../src/query-state.ts";
import { model } from "./lib/tool-stream.mjs";

const rows = [
	["foreign MCP call", [["f1", "mcp__foreign__read", 0]]],
	["bare built-in call", [["b1", "ToolSearch"]]],
	["missing id or name", [[undefined, undefined]]],
];
for (const [name, calls] of rows) it(name, () => {
	// arrange
	const query = new QueryContext();
	// act
	for (const [id, toolName] of calls) query.noteUnexpectedChildCall(id, toolName);
	// assert
	assert.equal(query.committedOutput, true);
	assert.equal(query.childSideCalls.size, 1);
});
it("turn and tool tracking resets retain the query's foreign-call guard", () => {
	// arrange
	const query = new QueryContext();
	query.noteUnexpectedChildCall("f1", "mcp__foreign__read");
	// act
	query.resetTurnState(model);
	query.resetToolTracking();
	// assert
	assert.equal(query.committedOutput, true);
	assert.equal(query.childSideCalls.get("f1")?.name, "mcp__foreign__read");
});
