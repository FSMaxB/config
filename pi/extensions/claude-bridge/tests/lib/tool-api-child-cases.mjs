import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { Type } from "typebox";
import { toolApiSession } from "./tool-api-session.mjs";

it("enforces inherited path denials and child call restrictions after late registration", async () => {
	// arrange
	const deniedPath = join(process.env.HOME, "denied.txt");
	const allowedPath = join(process.env.HOME, "allowed.txt");
	await writeFile(deniedPath, "private child input");
	await writeFile(allowedPath, "readable child input");
	const fixture = await toolApiSession({
		extensions: ["files.ts", "subagent/index.ts"].map(path => fileURLToPath(new URL(`../../../${path}`, import.meta.url))),
		factories: [pi => pi.registerTool({ name: "caller_fixture", label: "Child caller", description: "Exercise inherited policy",
			parameters: Type.Object({}), async execute(_id, _params, _signal, _update, context) {
				const denied = await context.executeTool("read", { path: deniedPath });
				const allowed = await context.executeTool("read", { path: allowedPath });
				const write = await context.executeTool("write", { path: join(process.cwd(), "child-write-probe.txt"), content: "x" });
				pi.registerTool({ name: "late_reader", label: "Late reader", description: "Not in the child allowlist",
					exposure: "deferred", annotations: { readOnlyHint: true }, parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "must not execute" }], details: undefined }) });
				const late = await context.executeTool("late_reader", {});
				return { content: [{ type: "text", text: JSON.stringify({ denied: denied.isError,
					denial: denied.result.content, allowed: allowed.isError, late: late.isError, write: write.isError }) }], details: undefined };
			} })],
	});
	try {
		// act
		const result = await fixture.call("caller_fixture");
		// assert
		assert.equal(result.isError, false);
		const nested = JSON.parse(result.content[0].text);
		assert.equal(nested.denied, true);
		assert.match(nested.denial[0].text, /denied for read access/);
		assert.equal(nested.allowed, false);
		assert.equal(nested.late, true);
		assert.equal(nested.write, true);
		assert.equal(existsSync(join(fixture.directory, "child-write-probe.txt")), false);
		assert.ok(!fixture.api.getAllTools().some(tool => tool.name === "subagent"));
	} finally { await fixture.dispose(); }
});
