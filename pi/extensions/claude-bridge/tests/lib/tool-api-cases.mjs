import assert from "node:assert/strict";
import { it, mock } from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { Check } from "typebox/value";
import { join } from "node:path";
import { Type } from "typebox";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { createCodemodeExtension } from "@earendil-works/pi-coding-agent";
import { resolveMcpTools } from "../../src/index.ts";
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

it("allows owned read-only tools without approval but rejects foreign hints and denied paths", async () => {
	// arrange
	const fixture = await toolApiSession({
		extensions: ["files.ts", "vcs.ts", "plan-mode.ts"].map(path => fileURLToPath(new URL(`../../../${path}`, import.meta.url))),
		entries: directory => [
			{ type: "plan-mode", data: { enabled: true, sessionGrants: [], sessionDenials: [] } },
			{ type: "path-permissions", data: { version: 2,
				read: { allow: [], deny: [{ kind: "exact", path: join(directory, "denied.txt") }] },
				write: { allow: [], deny: [] } } },
		],
		factories: [pi => pi.registerTool({ name: "foreign_reader", label: "Foreign reader", description: "Unverified hint",
			annotations: { readOnlyHint: true }, parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "must not execute" }], details: undefined }) })],
	});
	await writeFile(join(fixture.directory, "denied.txt"), "private");
	await writeFile(join(fixture.directory, "allowed.txt"), "readable");
	try {
		// act
		const vcs = await fixture.call("vcs_info");
		const foreign = await fixture.call("foreign_reader");
		const denied = await fixture.call("read", { path: join(fixture.directory, "denied.txt") });
		const allowed = await fixture.call("read", { path: join(fixture.directory, "allowed.txt") });
		// assert
		assert.equal(vcs.isError, false);
		assert.equal(foreign.isError, true);
		assert.match(foreign.content[0].text, /no interactive UI/);
		assert.equal(denied.isError, true);
		assert.match(denied.content[0].text, /denied for read access/);
		assert.equal(allowed.isError, false);
		assert.match(allowed.content[0].text, /readable/);
	} finally { await fixture.dispose(); }
});

it("does not transfer ownership trust to an SDK override of an owned VCS name", async () => {
	// arrange
	let executed = false;
	const fixture = await toolApiSession({
		extensions: ["vcs.ts", "plan-mode.ts"].map(path => fileURLToPath(new URL(`../../../${path}`, import.meta.url))),
		entries: [{ type: "plan-mode", data: { enabled: true, sessionGrants: [], sessionDenials: [] } }],
		customTools: [{ name: "vcs_info", label: "Foreign override", description: "Not the owned implementation",
			parameters: Type.Object({}), annotations: { readOnlyHint: true }, execute: async () => {
				executed = true;
				return { content: [{ type: "text", text: "foreign execution" }], details: undefined };
			} }],
	});
	try {
		// act
		const result = await fixture.call("vcs_info");
		// assert
		assert.equal(fixture.api.getAllTools().find(tool => tool.name === "vcs_info").sourceInfo.path, "<sdk:vcs_info>");
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /no interactive UI/);
		assert.equal(executed, false);
	} finally { await fixture.dispose(); }
});

it("filters spawn arguments and refuses a child with no plan-allowed tools", async () => {
	// arrange
	const extensions = ["files.ts", "plan-mode.ts", "subagent/index.ts"].map(path => fileURLToPath(new URL(`../../../${path}`, import.meta.url)));
	const spawned = [];
	const spawnMock = mock.method(childProcess, "spawn", (command, args, options) => {
		spawned.push({ command, args, options });
		const child = new EventEmitter();
		child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
		setImmediate(() => child.emit("close", 0));
		return child;
	});
	syncBuiltinESMExports();
	const fixture = await toolApiSession({ extensions,
		entries: [{ type: "plan-mode", data: { enabled: true, sessionGrants: [], sessionDenials: [{ name: "grep" }] } }] });
	try {
		// act
		const result = await fixture.call("subagent", { agent: "explore", task: "fixture" });
		// assert
		assert.equal(result.details.results[0].exitCode, 0, result.content[0].text);
		assert.equal(spawned.length, 1);
		const { args, options } = spawned[0];
		assert.equal(args[args.indexOf("--tools") + 1], "read,find,ls");
		assert.ok(!args.includes("--no-extensions"));
		assert.equal(options.env.PI_SUBAGENT_PLAN_ALLOWED_TOOLS, "find,ls,read");
		assert.ok(options.env.PI_SUBAGENT_PATH_POLICY);
		assert.ok(options.env.PI_SESSION_TEMP_DIR);
	} finally { await fixture.dispose(); }
	const blockedFixture = await toolApiSession({ extensions,
		entries: [{ type: "plan-mode", data: { enabled: true, sessionGrants: [],
			sessionDenials: ["read", "grep", "find", "ls"].map(name => ({ name })) } }] });
	try {
		// arrange
		spawned.length = 0;
		// act
		const result = await blockedFixture.call("subagent", { agent: "explore", task: "fixture" });
		// assert
		assert.equal(result.details.results[0].exitCode, 1);
		assert.match(result.content[0].text, /restricts every tool/);
		assert.equal(spawned.length, 0);
	} finally { await blockedFixture.dispose(); spawnMock.mock.restore(); syncBuiltinESMExports(); }
});

it("registry allowlists exclude deferred tools even after registration and activation", async () => {
	// arrange
	const fixture = await toolApiSession({ tools: ["caller_fixture"], factories: [pi => {
		pi.registerTool({ name: "excluded_fixture", label: "Excluded", description: "Deferred excluded tool",
			exposure: "deferred", parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "must not execute" }], details: undefined }) });
		pi.registerTool({ name: "caller_fixture", label: "Caller", description: "Try excluded tool",
			parameters: Type.Object({}), async execute(_id, _params, _signal, _update, context) {
				pi.setActiveTools(["caller_fixture", "excluded_fixture"]);
				pi.registerTool({ name: "late_fixture", label: "Late", description: "Late deferred tool", exposure: "deferred",
					parameters: Type.Object({}), execute: async () => ({ content: [], details: undefined }) });
				const excluded = await context.executeTool("excluded_fixture", {});
				const late = await context.executeTool("late_fixture", {});
				return { content: [{ type: "text", text: JSON.stringify({ excluded: excluded.isError, late: late.isError }) }], details: undefined };
			} });
	}] });
	try {
		// act
		const result = await fixture.call("caller_fixture");
		// assert
		assert.deepEqual(JSON.parse(result.content[0].text), { excluded: true, late: true });
		assert.deepEqual(fixture.session.getActiveToolNames(), ["caller_fixture"]);
	} finally { await fixture.dispose(); }
});

it("hides explicit denials while retaining active tools, gates, and codemode loadouts", async () => {
	// arrange
	const choices = [];
	const ui = new Proxy({
		theme: { fg: (_color, text) => text, bold: text => text },
		select: async (_title, items) => {
			const choice = choices.shift();
			assert.notEqual(choice, undefined, `Unexpected UI prompt: ${_title}`);
			return typeof choice === "function" ? choice(items) : choice;
		},
		input: async () => "test denial",
	}, { get: (target, property) => target[property] ?? (() => {}) });
	const fixture = await toolApiSession({
		extensions: [fileURLToPath(new URL("../../../plan-mode.ts", import.meta.url))],
		settings: { defaultTools: ["+codemode"] }, bindings: { uiContext: ui, mode: "tui" },
		entries: [{ type: "plan-mode", data: { enabled: true, sessionGrants: ["caller_fixture", "codemode"],
			sessionDenials: [{ name: "target_fixture" }, { name: "plan_path" }, { name: "late_fixture" }] } }],
		factories: [createCodemodeExtension({ mode: "on", inlineBudget: 100000 }), pi => {
			for (const name of ["target_fixture", "approval_fixture"]) pi.registerTool({
				name, label: name, description: name, parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "executed" }], details: undefined }),
			});
			pi.registerTool({ name: "caller_fixture", label: "Caller", description: "Nested caller", parameters: Type.Object({}),
				prepareLoadout: () => ({ descriptions: { caller_fixture: "Prepared caller description" } }),
				async execute(_id, _params, _signal, _update, context) {
					const result = await context.executeTool("target_fixture", {});
					return { content: [{ type: "text", text: JSON.stringify({ isError: result.isError,
						callable: context.tools.map(tool => tool.name) }) }], details: undefined };
				} });
		}],
	});
	const declared = () => getCurrentTools(fixture.requests.at(-1).messages).map(tool => tool.name);
	try {
		// act
		const nested = await fixture.call("caller_fixture");
		const scripted = await fixture.call("codemode", { code:
			'return { submit: typeof tools.submit_plan, blocked: await tools.target_fixture({}).then(() => "unexpected", error => error.message) };' });
		fixture.api.setActiveTools(fixture.api.getActiveTools());
		fixture.api.registerTool({ name: "late_fixture", label: "Late", description: "Late denied tool", parameters: Type.Object({}),
			execute: async () => ({ content: [], details: undefined }) });
		await fixture.session.prompt("Inspect declarations.");
		// assert
		assert.ok(!declared().includes("target_fixture"));
		assert.ok(!declared().includes("plan_path"));
		assert.ok(!declared().includes("late_fixture"));
		assert.ok(declared().includes("approval_fixture"));
		assert.ok(declared().includes("codemode"));
		assert.ok(fixture.api.getActiveTools().includes("target_fixture"));
		assert.ok(fixture.api.getActiveTools().includes("plan_path"));
		assert.equal(JSON.parse(nested.content[0].text).isError, true);
		assert.equal(scripted.isError, false, JSON.stringify(scripted));
		assert.match(scripted.content.map(block => block.text).join("\n"), /undefined/);
		assert.match(scripted.content.map(block => block.text).join("\n"), /denied/);
		assert.ok(JSON.parse(nested.content[0].text).callable.includes("target_fixture"));
		const bridgeTools = resolveMcpTools(fixture.requests.at(-1)).mcpTools;
		assert.ok(!bridgeTools.some(tool => tool.name === "target_fixture"));
		assert.equal(bridgeTools.find(tool => tool.name === "caller_fixture").description, "Prepared caller description");
		// arrange
		choices.push(items => items.find(item => item.includes("target_fixture")), "Done");
		// act
		await fixture.session.prompt("/plan grants");
		await fixture.session.prompt("Inspect declarations after removal.");
		// assert
		assert.ok(declared().includes("target_fixture"));
		// arrange
		choices.push("Deny in session");
		// act
		const denied = await fixture.call("approval_fixture");
		// assert
		assert.equal(denied.isError, true);
		assert.ok(!declared().includes("approval_fixture"));
		// arrange
		choices.push("Clear all");
		// act
		await fixture.session.prompt("/plan grants");
		await fixture.session.prompt("Inspect declarations after clearing.");
		// assert
		assert.ok(declared().includes("approval_fixture"));
		assert.ok(declared().includes("plan_path"));
		// act
		fixture.api.setActiveTools(fixture.api.getActiveTools().filter(name => name !== "target_fixture"));
		await fixture.session.prompt("/plan");
		await fixture.session.prompt("Inspect declarations outside plan mode.");
		// assert
		assert.ok(!fixture.api.getActiveTools().includes("plan_path"));
		assert.ok(!fixture.api.getActiveTools().includes("submit_plan"));
		assert.ok(!fixture.api.getActiveTools().includes("target_fixture"));
		assert.ok(declared().includes("approval_fixture"));
		assert.equal(choices.length, 0);
	} finally { await fixture.dispose(); }
});

it("returns schema-valid bounded VCS results for all tools and paging branches", async () => {
	// arrange
	const fixture = await toolApiSession({ extensions: [fileURLToPath(new URL("../../../vcs.ts", import.meta.url))] });
	const execute = promisify(childProcess.execFile);
	try {
		// act
		const missing = await fixture.call("vcs_info");
		// assert
		assert.equal(missing.structuredContent.kind, "none");
		assert.equal(missing.isError, false);
		assert.ok(Check(fixture.definitions.get("vcs_info").outputSchema, missing.structuredContent));
		// arrange
		await execute("jj", ["git", "init", "--colocate", fixture.directory]);
		await execute("jj", ["-R", fixture.directory, "config", "set", "--repo", "user.name", "Fixture"]);
		await execute("jj", ["-R", fixture.directory, "config", "set", "--repo", "user.email", "fixture@example.invalid"]);
		await writeFile(join(fixture.directory, "sample.txt"), Array.from({ length: 2100 }, (_, index) => `line ${index}`).join("\n"));
		await writeFile(join(fixture.directory, "other.txt"), "second change");
		const cases = [
			["vcs_info", {}], ["vcs_status", { limit: 1 }], ["vcs_branches", {}], ["vcs_log", {}],
			["vcs_show", { revision: "@" }], ["vcs_diff", {}], ["vcs_file", { revision: "@", path: "sample.txt" }],
			["vcs_blame", { path: "sample.txt", limit: 2 }],
		];
		// act
		const results = [];
		for (const [name, parameters] of cases) results.push(await fixture.call(name, parameters));
		const page = await fixture.call("vcs_file", { revision: "@", path: "sample.txt", offset: 2, limit: 2 });
		await writeFile(join(fixture.directory, "long.txt"), "x".repeat(60000));
		const long = await fixture.call("vcs_file", { revision: "@", path: "long.txt" });
		// assert
		results.forEach((result, index) => {
			assert.equal(result.isError, false, JSON.stringify(result.content));
			assert.ok(Check(fixture.definitions.get(cases[index][0]).outputSchema, result.structuredContent));
			assert.equal(result.structuredContent.output, result.content[0].text);
			assert.equal(result.structuredContent.kind, "jj");
			assert.ok(Buffer.byteLength(result.structuredContent.output) < 52000);
		});
		assert.equal(results[1].structuredContent.truncated, true);
		assert.equal(results[6].structuredContent.truncated, true);
		assert.equal(page.structuredContent.truncated, false);
		assert.match(page.structuredContent.output, /line 1\nline 2/);
		assert.equal(long.structuredContent.truncated, true);
		assert.match(long.structuredContent.output, /first line alone exceeds/);
	} finally { await fixture.dispose(); }
});

it("returns the same structured VCS contract in a git-only fixture", async () => {
	// arrange
	const fixture = await toolApiSession({ extensions: [fileURLToPath(new URL("../../../vcs.ts", import.meta.url))] });
	const execute = promisify(childProcess.execFile);
	try {
		await execute("git", ["init", fixture.directory]);
		await writeFile(join(fixture.directory, "sample.txt"), "git fixture");
		await execute("git", ["-C", fixture.directory, "add", "sample.txt"]);
		await execute("git", ["-C", fixture.directory, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Fixture"]);
		// act
		const info = await fixture.call("vcs_info");
		const file = await fixture.call("vcs_file", { revision: "HEAD", path: "sample.txt" });
		const diff = await fixture.call("vcs_diff");
		// assert
		for (const result of [info, file, diff]) {
			assert.equal(result.isError, false);
			assert.equal(result.structuredContent.kind, "git");
			assert.equal(result.structuredContent.colocated, false);
			assert.equal(result.structuredContent.output, result.content[0].text);
		}
		assert.equal(file.structuredContent.output, "git fixture");
		assert.equal(diff.structuredContent.output, "(no output)");
	} finally { await fixture.dispose(); }
});

it("reports finalized delegated usage once and flags single/parallel failures", async () => {
	// arrange
	let childFails = false;
	let childTermination;
	const childUsage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 3, totalTokens: 20,
		reasoning: 4, cacheWrite1h: 1, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } };
	const nestedUsage = { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
		cost: { input: 0.5, output: 1, cacheRead: 0, cacheWrite: 0, total: 1.5 } };
	const spawnMock = mock.method(childProcess, "spawn", () => {
		const child = new EventEmitter();
		child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
		const failed = childFails;
		const terminationSignal = childTermination;
		setImmediate(() => {
			const toolMessage = { role: "toolResult", toolCallId: "child-nested", toolName: "child_tool",
				content: [{ type: "text", text: "Recovered tool error" }], isError: true, timestamp: 1, usage: nestedUsage };
			for (const event of [
				{ type: "message_update", message: { role: "assistant", usage: childUsage } },
				{ type: "message_end", message: toolMessage },
				{ type: "tool_result_end", message: toolMessage },
				{ type: "tool_execution_end", toolCallId: "child-nested", result: { usage: nestedUsage } },
				{ type: "turn_end", message: { role: "assistant", usage: childUsage }, toolResults: [toolMessage] },
				{ type: "agent_end", messages: [toolMessage, { role: "assistant", usage: childUsage }] },
				{ type: "message_end", message: { role: "assistant", api: "tool-api-test", provider: "tool-api-test", model: "fake",
					content: [], timestamp: 1, stopReason: "error", errorMessage: "Recovered attempt",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
				{ type: "message_end", message: { role: "assistant", api: "tool-api-test", provider: "tool-api-test", model: "fake",
					content: [{ type: "text", text: "Child complete" }], timestamp: 2, usage: childUsage,
					stopReason: failed ? "error" : "stop", ...(failed ? { errorMessage: "Fixture child failure" } : {}) } },
			]) child.stdout.write(`${JSON.stringify(event)}\n`);
			child.emit("close", terminationSignal ? null : 0, terminationSignal);
		});
		return child;
	});
	syncBuiltinESMExports();
	const fixture = await toolApiSession({ extensions: [fileURLToPath(new URL("../../../subagent/index.ts", import.meta.url))] });
	try {
		// act
		const success = await fixture.call("subagent", { agent: "explore", task: "fixture" });
		const mixed = await fixture.call("subagent", { tasks: [{ agent: "explore", task: "fixture" }, { agent: "unknown", task: "fixture" }] });
		const invalid = await fixture.call("subagent");
		const tooMany = await fixture.call("subagent", { tasks: Array.from({ length: 9 }, () => ({ agent: "explore", task: "fixture" })) });
		childTermination = "SIGKILL";
		const killed = await fixture.call("subagent", { agent: "explore", task: "fixture" });
		childTermination = undefined;
		childFails = true;
		const failed = await fixture.call("subagent", { agent: "explore", task: "fixture" });
		// assert
		assert.equal(success.isError, false);
		assert.equal(success.usage.input, 12);
		assert.equal(success.usage.output, 8);
		assert.equal(success.usage.totalTokens, 25);
		assert.equal(success.usage.reasoning, 4);
		assert.equal(success.usage.cacheWrite1h, 1);
		assert.equal(success.usage.cost.total, 11.5);
		assert.equal(success.details.results[0].usage.contextTokens, 20);
		assert.equal(success.details.results[0].usage.cost, 11.5);
		assert.equal(success.details.results[0].messages.filter(message => message.role === "toolResult").length, 1);
		assert.equal(mixed.isError, true);
		assert.equal(mixed.details.results.length, 2);
		assert.deepEqual(mixed.usage, success.usage);
		assert.equal(invalid.isError, true);
		assert.equal(invalid.usage.totalTokens, 0);
		assert.equal(tooMany.isError, true);
		assert.equal(tooMany.usage.cost.total, 0);
		assert.equal(killed.isError, true);
		assert.match(killed.content[0].text, /terminated by SIGKILL/);
		assert.equal(killed.usage.totalTokens, 25);
		assert.equal(failed.isError, true);
		assert.match(failed.content[0].text, /Fixture child failure/);
		const finalized = fixture.session.messages.filter(message => message.role === "toolResult" && message.toolName === "subagent");
		assert.equal(finalized.length, 6);
		assert.equal(finalized.reduce((sum, message) => sum + (message.usage?.totalTokens ?? 0), 0), 100);
	} finally { await fixture.dispose(); spawnMock.mock.restore(); syncBuiltinESMExports(); }
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
