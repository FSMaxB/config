import assert from "node:assert/strict";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { toolApiSession } from "./tool-api-session.mjs";

it("keeps model-only tools declared but excludes nested execution", async () => {
	// arrange
	const fixture = await toolApiSession({ factories: [(pi) => {
		pi.registerTool({ name: "interactive_fixture", label: "Interactive fixture", description: "Direct only",
			parameters: Type.Object({}), exposure: "model-only",
			execute: async () => ({ content: [{ type: "text", text: "direct success" }], details: undefined }) });
		pi.registerTool({ name: "caller_fixture", label: "Caller fixture", description: "Try nested execution",
			parameters: Type.Object({}), async execute(_id, _parameters, _signal, _update, context) {
				const outcome = await context.executeTool("interactive_fixture", {});
				return { content: [{ type: "text", text: JSON.stringify({ callable: context.tools.map(tool => tool.name),
					isError: outcome.isError }) }], details: undefined };
			} });
	}] });
	try {
		// act
		const direct = await fixture.call("interactive_fixture");
		const nested = await fixture.call("caller_fixture");
		// assert
		assert.equal(direct.isError, false);
		assert.equal(direct.content[0].text, "direct success");
		const result = JSON.parse(nested.content[0].text);
		assert.equal(result.isError, true);
		assert.ok(!result.callable.includes("interactive_fixture"));
		assert.ok(getCurrentTools(fixture.requests.at(-1).messages).some(tool => tool.name === "interactive_fixture"));
	} finally { await fixture.dispose(); }
});

it("registers the agreed exposures, namespaces, and trusted read-only hints", async () => {
	// arrange
	const fixture = await toolApiSession({ extensions: ["files.ts", "vcs.ts", "question.ts", "plan-mode.ts", "crit.ts", "tuicr.ts", "subagent/index.ts"]
		.map(path => fileURLToPath(new URL(`../../../${path}`, import.meta.url))) });
	try {
		// act
		const definitions = [...fixture.definitions.values()];
		const modelOnly = definitions.filter(tool => tool.exposure === "model-only").map(tool => tool.name).sort();
		// assert
		assert.deepEqual(modelOnly, ["crit_review", "question", "subagent", "submit_plan", "tuicr_open", "tuicr_wait"]);
		for (const tool of definitions) {
			const expectedNamespace = tool.name.startsWith("vcs_") ? "vcs"
				: tool.name.startsWith("crit_") ? "crit"
				: tool.name.startsWith("tuicr_") ? "tuicr"
				: ["plan_path", "submit_plan"].includes(tool.name) ? "planning"
				: ["read", "write", "edit", "ls", "find", "grep", "delete"].includes(tool.name) ? "files" : undefined;
			assert.equal(tool.namespace?.name, expectedNamespace, tool.name);
			const readOnly = ["read", "ls", "find", "grep", "crit_comments", "crit_status"].includes(tool.name) || tool.name.startsWith("vcs_");
			assert.equal(tool.annotations?.readOnlyHint === true, readOnly, tool.name);
			assert.equal(typeof tool.execute, "function");
			assert.equal(tool.parameters.type, "object");
		}
	} finally { await fixture.dispose(); }
});
