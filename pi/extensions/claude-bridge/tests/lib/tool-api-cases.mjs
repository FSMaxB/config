import assert from "node:assert/strict";
import { it, mock } from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { Check } from "typebox/value";
import { join } from "node:path";
import { Type } from "typebox";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { createCodemodeExtension } from "@earendil-works/pi-coding-agent";
import { resolveMcpTools } from "../../src/index.ts";
import { toolApiSession } from "./tool-api-session.mjs";
import { cwdSlug } from "../../../lib/plan-naming.ts";

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
		assert.equal(options.env.PI_SUBAGENT_ALLOWED_TOOLS, "find,ls,read");
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

it("caps subagent tools by the exploring mode's own decisions", async () => {
	// arrange
	const extensions = ["files.ts", "explore-mode.ts", "subagent/index.ts"].map(path => fileURLToPath(new URL(`../../../${path}`, import.meta.url)));
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
		entries: [
			{ type: "explore-mode", data: { enabled: true, sessionGrants: [], sessionDenials: [{ name: "grep" }] } },
			{ type: "plan-mode", data: { enabled: false, sessionGrants: [], sessionDenials: [] } },
		] });
	try {
		// act
		const result = await fixture.call("subagent", { agent: "explore", task: "fixture" });
		// assert
		assert.equal(result.details.results[0].exitCode, 0, result.content[0].text);
		const { args, options } = spawned[0];
		assert.equal(args[args.indexOf("--tools") + 1], "read,find,ls");
		assert.equal(options.env.PI_SUBAGENT_ALLOWED_TOOLS, "find,ls,read");
		assert.equal(options.env.PI_SUBAGENT_RESTRICTING_MODE, "exploring");
		assert.equal(JSON.parse(options.env.PI_SUBAGENT_PATH_POLICY).ruleStore, "explore");
	} finally { await fixture.dispose(); spawnMock.mock.restore(); syncBuiltinESMExports(); }
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

// Declarations stay fixed across denials and mode changes to keep the prompt cache prefix; the
// model learns about denials from the agent-mode snapshot message instead.
it("keeps explicit denials declared but blocked and announced in the agent-mode snapshot", async () => {
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
	// The request carries the hidden agent-mode snapshot as an ordinary user message.
	const snapshot = () => fixture.requests.at(-1).messages
		.filter(message => message.role === "user")
		.map(message => (typeof message.content === "string" ? message.content : message.content.map(block => block.text ?? "").join("\n")))
		.findLast(text => text.startsWith("This is the current agent-mode state."));
	const deniedInSnapshot = name => new RegExp(`^ {2}- ${name}( \\(do this instead: .*\\))?$`, "m").test(snapshot());
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
		for (const name of ["target_fixture", "plan_path", "late_fixture", "approval_fixture", "codemode"]) {
			assert.ok(declared().includes(name), `${name} must stay declared`);
		}
		for (const name of ["target_fixture", "plan_path", "late_fixture"]) {
			assert.ok(deniedInSnapshot(name), `${name} must be listed as denied in:\n${snapshot()}`);
		}
		assert.ok(!deniedInSnapshot("approval_fixture"));
		assert.ok(fixture.api.getActiveTools().includes("target_fixture"));
		assert.ok(fixture.api.getActiveTools().includes("plan_path"));
		assert.equal(JSON.parse(nested.content[0].text).isError, true);
		assert.equal(scripted.isError, false, JSON.stringify(scripted));
		assert.match(scripted.content.map(block => block.text).join("\n"), /undefined/);
		assert.match(scripted.content.map(block => block.text).join("\n"), /denied/);
		assert.ok(JSON.parse(nested.content[0].text).callable.includes("target_fixture"));
		const bridgeTools = resolveMcpTools(fixture.requests.at(-1)).mcpTools;
		assert.ok(bridgeTools.some(tool => tool.name === "target_fixture"));
		assert.equal(bridgeTools.find(tool => tool.name === "caller_fixture").description, "Prepared caller description");
		// arrange
		choices.push(items => items.find(item => item.includes("target_fixture")), "Done");
		// act
		await fixture.session.prompt("/plan grants");
		await fixture.session.prompt("Inspect declarations after removal.");
		// assert
		assert.ok(declared().includes("target_fixture"));
		assert.ok(!deniedInSnapshot("target_fixture"));
		// arrange
		choices.push("Deny in session");
		// act
		const denied = await fixture.call("approval_fixture");
		await fixture.session.prompt("Inspect declarations after a denial.");
		// assert
		assert.equal(denied.isError, true);
		assert.ok(declared().includes("approval_fixture"));
		assert.match(snapshot(), /^ {2}- approval_fixture \(do this instead: test denial\)$/m);
		// arrange
		choices.push("Clear all");
		// act
		await fixture.session.prompt("/plan grants");
		await fixture.session.prompt("Inspect declarations after clearing.");
		// assert
		assert.ok(declared().includes("approval_fixture"));
		assert.ok(declared().includes("plan_path"));
		assert.doesNotMatch(snapshot(), /denied these tools/);
		// act
		fixture.api.setActiveTools(fixture.api.getActiveTools().filter(name => name !== "target_fixture"));
		await fixture.session.prompt("/plan");
		await fixture.session.prompt("Inspect declarations outside plan mode.");
		const rejected = await fixture.call("plan_path", { slug: "fixture" });
		// assert
		assert.match(snapshot(), /Plan mode and explore mode are off/);
		assert.ok(fixture.api.getActiveTools().includes("plan_path"));
		assert.ok(fixture.api.getActiveTools().includes("submit_plan"));
		assert.ok(!fixture.api.getActiveTools().includes("target_fixture"));
		assert.ok(declared().includes("approval_fixture"));
		assert.match(rejected.content[0].text, /only available in plan mode, which is off/);
		assert.equal(choices.length, 0);
	} finally { await fixture.dispose(); }
});

// Switching modes may only append one snapshot message: declarations and earlier messages are the
// provider's cache prefix.
it("switches between explore, plan and normal mode by appending snapshots only", async () => {
	// arrange
	const prompts = [];
	const ui = new Proxy({
		theme: { fg: (_color, text) => text, bold: text => text },
		select: async title => { prompts.push(title); return "Deny once"; },
		input: async () => "",
	}, { get: (target, property) => target[property] ?? (() => {}) });
	const fixture = await toolApiSession({
		extensions: ["explore-mode.ts", "plan-mode.ts"].map(path => fileURLToPath(new URL(`../../../${path}`, import.meta.url))),
		bindings: { uiContext: ui, mode: "tui" },
		factories: [pi => pi.registerTool({ name: "approval_fixture", label: "Approval", description: "Needs approval",
			parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "executed" }], details: undefined }) })],
	});
	const request = () => fixture.requests.at(-1).messages;
	const declared = () => getCurrentTools(request()).map(tool => tool.name);
	const snapshots = () => request().filter(message => message.role === "user")
		.map(message => (typeof message.content === "string" ? message.content : message.content.map(block => block.text ?? "").join("\n")))
		.filter(text => text.startsWith("This is the current agent-mode state."));
	try {
		// act
		await fixture.session.prompt("Before.");
		const baseline = { declared: declared(), messages: structuredClone(request()), snapshots: snapshots().length };
		await fixture.session.prompt("/explore");
		await fixture.session.prompt("While exploring.");
		const exploring = { declared: declared(), messages: structuredClone(request()), snapshot: snapshots().at(-1), count: snapshots().length };
		const denied = await fixture.call("approval_fixture");
		await fixture.session.prompt("/plan");
		await fixture.session.prompt("While planning.");
		const planning = { declared: declared(), snapshot: snapshots().at(-1) };
		await fixture.session.prompt("/plan");
		await fixture.session.prompt("After.");
		const normal = { declared: declared(), snapshot: snapshots().at(-1) };
		// assert
		assert.equal(baseline.snapshots, 1);
		assert.deepEqual(exploring.messages.slice(0, baseline.messages.length), baseline.messages);
		assert.equal(exploring.count, 2);
		assert.match(exploring.snapshot, /Explore mode is active/);
		assert.doesNotMatch(exploring.snapshot, /call plan_path once/);
		assert.equal(denied.isError, true);
		assert.match(denied.content[0].text, /Explore mode is active and the user denied this call/);
		assert.match(prompts[0], /^Explore mode — allow approval_fixture\?/);
		assert.match(planning.snapshot, /Plan mode is active/);
		assert.match(normal.snapshot, /Plan mode and explore mode are off/);
		for (const names of [exploring.declared, planning.declared, normal.declared]) assert.deepEqual(names, baseline.declared);
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

it("submits an approved Crit plan before another model request and preserves implementation access", async () => {
	// arrange
	await withCritPlanSession({}, async ({ fixture, plan, dialogs, processes }) => {
		// act
		const result = await fixture.call("crit_review", { plan });
		// assert
		assert.equal(result.isError, false, JSON.stringify(result.content));
		assert.equal(dialogs.length, 1);
		assert.equal(fixture.definitions.get("crit_review").parameters.properties.suggestedModel, undefined);
		assert.equal(fixture.definitions.get("crit_review").parameters.properties.suggestedModelReason, undefined);
		assert.deepEqual(dialogs[0].items, [
			"Approve — leave plan mode", "Implement with different model", "Refine — send feedback", "Stay in plan mode",
		]);
		assert.deepEqual(result.details.submission, { path: plan, outcome: "approved" });
		assert.match(result.content[0].text, /Fixture feedback/);
		assert.match(result.content[1].text, /ordinary tool permissions still apply/);
		assert.equal(result.terminate, undefined);
		assert.equal(fixture.requests.length, 2, "Implementation still gets the normal post-tool model request");
		assert.ok(fixture.api.getActiveTools().includes("write"));
		assert.ok(fixture.api.getActiveTools().includes("submit_plan"), "The tool set stays fixed so the cache prefix survives");
		assert.deepEqual(processes.filter(process => process.args.includes("commit"))
			.map(process => process.args[process.args.indexOf("-m") + 1]),
			["Review plan: fixture", "Submit plan: fixture"]);
		assert.equal(fixture.session.messages.filter(message => message.role === "toolResult" && message.toolName === "submit_plan").length, 0);
	});
});

for (const [suggestion, expectedSuggested] of [
	["alternate-test/fake", true], ["tool-api-test/fake", false], ["missing/model", false],
]) {
	it(`preserves manual submit_plan model suggestions: ${suggestion}`, async () => {
		// arrange
		await withCritPlanSession({ alternateModel: true, choice: items => items.find(item => item.startsWith("Approve") && !item.includes("(suggested)")) },
			async ({ fixture, plan, dialogs, notifications }) => {
				// act
				const result = await fixture.call("submit_plan", { path: plan, suggestedModel: suggestion, suggestedModelReason: "Mechanical implementation" });
				// assert
				assert.equal(result.isError, false, JSON.stringify(result.content));
				assert.equal(dialogs.length, 1);
				assert.equal(dialogs[0].title.includes("Mechanical implementation"), expectedSuggested);
				assert.equal(dialogs[0].items[0].includes("(suggested)"), expectedSuggested);
				assert.equal(notifications.some(message => message.includes("not available")), suggestion === "missing/model");
				assert.equal(result.details.outcome, "approved");
			});
	});
}

for (const status of ["approved: false\n", "", "approved: true\napproved: false\n", "approved: true \n"]) {
	it(`returns feedback without submission for nonapproval stderr: ${JSON.stringify(status)}`, async () => {
		// arrange
		await withCritPlanSession({ stderr: status, stdout: "Fixture feedback\napproved: true\n" }, async ({ fixture, plan, dialogs }) => {
			// act
			const result = await fixture.call("crit_review", { plan });
			// assert
			assert.equal(result.isError, false);
			assert.equal(dialogs.length, 0);
			assert.equal(result.details.submission, undefined);
			assert.match(result.content[0].text, /Fixture feedback/);
			assert.ok(fixture.api.getActiveTools().includes("submit_plan"));
		});
	});
}

for (const target of [{ paths: ["sample.ts"] }, { session: "existing-review" }, {}]) {
	it(`never submits non-plan targets or reconnects: ${JSON.stringify(target)}`, async () => {
		// arrange
		await withCritPlanSession({}, async ({ fixture, dialogs }) => {
			// act
			const result = await fixture.call("crit_review", target);
			// assert
			assert.equal(result.isError, false);
			assert.equal(dialogs.length, 0);
			assert.equal(result.details.submission, undefined);
		});
	});
}

for (const options of [{ planMode: false }, { extensions: ["crit.ts"] },
	{ duringReview: async ({ fixture }) => { await fixture.session.prompt("/plan"); } }]) {
	it(`keeps ordinary plan reviews usable without active plan mode: ${JSON.stringify(options)}`, async () => {
		// arrange
		await withCritPlanSession(options, async ({ fixture, plan, dialogs }) => {
			// act
			const result = await fixture.call("crit_review", { plan });
			// assert
			assert.equal(result.isError, false, JSON.stringify(result.content));
			assert.equal(dialogs.length, 0);
			assert.equal(result.details.submission, undefined);
			assert.match(result.content[0].text, /Fixture feedback/);
		});
	});
}

for (const options of [{ denials: [{ name: "submit_plan", note: "Wait for review" }], failure: /denied.*session/ },
	{ deactivateSubmission: true, failure: /deactivated/ }]) {
	it("does not bypass explicit denial or manual deactivation of submission", async () => {
		// arrange
		await withCritPlanSession(options, async ({ fixture, plan, dialogs }) => {
			// act
			const result = await fixture.call("crit_review", { plan });
			// assert
			assert.equal(result.isError, true);
			assert.match(result.content[0].text, options.failure);
			assert.equal(dialogs.length, 0);
			assert.ok(fixture.api.getActiveTools().includes("plan_path"));
		});
	});
}

it("does not submit after a nonzero Crit exit", async () => {
	// arrange
	await withCritPlanSession({ code: 2 }, async ({ fixture, plan, dialogs }) => {
		// act
		const result = await fixture.call("crit_review", { plan });
		// assert
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /exited with 2/);
		assert.equal(dialogs.length, 0);
	});
});

it("does not submit when Crit is aborted", async () => {
	// arrange
	await withCritPlanSession({ duringReview: ({ fixture }) => { void fixture.session.abort(); } },
		async ({ fixture, plan, dialogs }) => {
			// act
			await fixture.call("crit_review", { plan });
			// assert
			assert.equal(dialogs.length, 0);
			assert.ok(fixture.api.getActiveTools().includes("submit_plan"));
		});
});

for (const [choice, outcome] of [["Refine — send feedback", "refine"], ["Stay in plan mode", "saved"], [undefined, "saved"]]) {
	it(`preserves the existing nonapproval submission decision: ${choice}`, async () => {
		// arrange
		await withCritPlanSession({ choice }, async ({ fixture, plan, dialogs }) => {
			// act
			const result = await fixture.call("crit_review", { plan });
			// assert
			assert.equal(result.isError, false);
			assert.equal(dialogs.length, 1);
			assert.equal(result.details.submission.outcome, outcome);
			assert.ok(fixture.api.getActiveTools().includes("submit_plan"));
			if (outcome === "refine") assert.match(result.content[1].text, /Use smaller steps/);
		});
	});
}

for (const options of [{ missingFile: true, outcome: "missing" }, { noUI: true, outcome: "saved" }]) {
	it(`preserves validation and no-UI outcomes during automatic submission: ${options.outcome}`, async () => {
		// arrange
		await withCritPlanSession(options, async ({ fixture, plan, dialogs }) => {
			// act
			const result = await fixture.call("crit_review", { plan });
			// assert
			assert.equal(result.isError, false);
			assert.equal(dialogs.length, 0);
			assert.equal(result.details.submission.outcome, options.outcome);
			assert.ok(fixture.api.getActiveTools().includes("submit_plan"));
		});
	});
}

it("refuses to submit a plan file outside the plans directory", async () => {
	// arrange
	await withCritPlanSession({}, async ({ fixture, dialogs, processes }) => {
		const outside = join(fixture.directory, "outside.md");
		await writeFile(outside, "# Not a plan");
		// act
		const result = await fixture.call("submit_plan", { path: outside });
		// assert
		assert.equal(result.details.outcome, "outside-plans-directory");
		assert.equal(dialogs.length, 0);
		assert.equal(processes.length, 0);
	});
});

it("discovers exactly one handler after reload with reversed extension load order", async () => {
	// arrange
	await withCritPlanSession({ extensions: ["plan-mode.ts", "crit.ts"], choice: "Stay in plan mode" },
		async ({ fixture, plan, dialogs }) => {
			// act
			const first = await fixture.call("crit_review", { plan });
			await fixture.session.reload();
			const second = await fixture.call("crit_review", { plan });
			// assert
			assert.equal(first.isError, false);
			assert.equal(second.isError, false, JSON.stringify(second.content));
			assert.equal(dialogs.length, 2);
			assert.equal(second.details.submission.outcome, "saved");
		});
});

for (const contextChoice of [
	"Full context — inherit the whole conversation",
	"Compact — summarize, then implement in a fresh turn",
	"Fresh session — only the plan file, nothing else",
]) {
	it(`retains single implementation handoff wiring: ${contextChoice}`, async () => {
		// arrange
		await withCritPlanSession({ choice: "Implement with different model", contextChoice },
			async ({ fixture, plan, dialogs }) => {
				const messages = [];
				const compactMock = mock.method(fixture.session, "compact", async () => ({}));
				const sendMock = mock.method(fixture.session, "sendUserMessage", async (message, options) => { messages.push({ message, options }); });
				try {
					// act
					const result = await fixture.call("crit_review", { plan });
					await new Promise(resolve => setImmediate(resolve));
					// assert
					assert.equal(result.isError, false, JSON.stringify(result.content));
					assert.equal(result.details.submission.outcome, "handed-off");
					assert.equal(dialogs.filter(dialog => dialog.title.startsWith("Plan submitted")).length, 1);
					assert.ok(fixture.api.getActiveTools().includes("submit_plan"));
					if (contextChoice.startsWith("Compact")) {
						assert.equal(compactMock.mock.callCount(), 1);
						assert.deepEqual(messages.map(item => item.message), [`Implement the plan at ${plan}.`]);
					} else if (contextChoice.startsWith("Fresh")) {
						assert.equal(compactMock.mock.callCount(), 0);
						assert.deepEqual(messages, [{ message: "/plan fresh-handoff", options: { expandPromptTemplates: true } }]);
						// arrange
						const handoffs = [];
						const newSession = async options => {
							await options.setup({ appendCustomEntry: (type, data) => handoffs.push({ type, data }) });
							return { cancelled: false };
						};
						await fixture.session.bindExtensions({ commandContextActions: { newSession } });
						// act
						await fixture.session.prompt("/plan fresh-handoff");
						// assert
						assert.deepEqual(handoffs, [{ type: "plan-handoff", data: {
							planPath: plan, provider: "tool-api-test", modelId: "fake", thinkingLevel: "off",
						} }]);
					} else {
						assert.equal(compactMock.mock.callCount(), 0);
						assert.equal(messages.length, 0);
						assert.match(result.content[1].text, /ordinary tool permissions still apply/);
					}
				} finally { compactMock.mock.restore(); sendMock.mock.restore(); }
			});
	});
}

it("rechecks cancellation after the submission commit before opening the dialog", async () => {
	// arrange
	await withCritPlanSession({
		duringProcess: ({ fixture, args }) => {
			if (args.includes("Submit plan: fixture")) void fixture.session.abort();
		},
	}, async ({ fixture, plan, dialogs, processes }) => {
		// act
		await fixture.call("crit_review", { plan });
		// assert
		assert.ok(processes.some(process => process.args.includes("Submit plan: fixture")));
		assert.equal(dialogs.length, 0);
		assert.ok(fixture.api.getActiveTools().includes("submit_plan"));
	});
});

it("lets the user select an alternate model through the existing fresh handoff", async () => {
	// arrange
	await withCritPlanSession({ alternateModel: true,
		choice: "Implement with different model",
		modelChoice: "alternate-test/fake",
		contextChoice: "Fresh session — only the plan file, nothing else",
	}, async ({ fixture, plan, dialogs }) => {
		const messages = [];
		const sendMock = mock.method(fixture.session, "sendUserMessage", async message => { messages.push(message); });
		try {
			// act
			const result = await fixture.call("crit_review", { plan });
			// assert
			assert.equal(result.isError, false);
			assert.equal(result.details.submission.outcome, "handed-off");
			assert.equal(dialogs.length, 2);
			assert.ok(!dialogs[0].title.includes("Suggests"));
			assert.deepEqual(messages, ["/plan fresh-handoff"]);
			// arrange
			const handoffs = [];
			await fixture.session.bindExtensions({ commandContextActions: { newSession: async options => {
				await options.setup({ appendCustomEntry: (type, data) => handoffs.push({ type, data }) });
				return { cancelled: false };
			} } });
			// act
			await fixture.session.prompt("/plan fresh-handoff");
			// assert
			assert.equal(handoffs.length, 1);
			assert.equal(handoffs[0].data.provider, "alternate-test");
			assert.equal(handoffs[0].data.planPath, plan);
		} finally { sendMock.mock.restore(); }
	});
});

it("keeps discovery isolated across two live SDK sessions", async () => {
	// arrange
	await withCritPlanSession({}, async ({ fixture, plan, dialogs }) => {
		const second = await toolApiSession({ extensions: [fileURLToPath(new URL("../../../crit.ts", import.meta.url))] });
		const secondPlan = join(second.directory, "second-plan.md");
		try {
			await writeFile(secondPlan, "# Second session plan");
			// act
			const result = await second.call("crit_review", { plan: secondPlan });
			// assert
			assert.equal(result.isError, false);
			assert.equal(result.details.submission, undefined);
			assert.equal(dialogs.length, 0);
			assert.ok(fixture.api.getActiveTools().includes("submit_plan"));
		} finally { await second.dispose(); }
		// act
		const firstResult = await fixture.call("crit_review", { plan });
		// assert
		assert.equal(firstResult.isError, false);
		assert.equal(firstResult.details.submission.outcome, "approved");
		assert.equal(dialogs.length, 1);
	});
});

it("keeps both real tools inaccessible to codemode and nested tool execution", async () => {
	// arrange
	await withCritPlanSession({ codemode: true }, async ({ fixture, dialogs }) => {
		// act
		const scripted = await fixture.call("codemode", { code: "text([typeof tools.crit_review, typeof tools.submit_plan]);" });
		const nested = await fixture.call("nested_review_fixture");
		// assert
		assert.equal(scripted.isError, false);
		assert.match(scripted.content.map(block => block.text).join("\n"), /undefined/);
		assert.deepEqual(JSON.parse(nested.content[0].text), [true, true]);
		assert.equal(dialogs.length, 0);
	});
});

async function withCritPlanSession(options, run) {
	const dialogs = [];
	const notifications = [];
	const processes = [];
	let fixture;
	let plan;
	let planDirectory;
	let expectedRequestCount;
	const spawnMock = mock.method(childProcess, "spawn", (command, args) => {
		processes.push({ command, args });
		assert.ok(["crit", "jj", "git"].includes(command), `Unexpected process: ${command}`);
		const child = new EventEmitter();
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		let closed = false;
		const close = code => { if (!closed) { closed = true; child.emit("close", code); } };
		child.kill = () => { close(null); return true; };
		setImmediate(async () => {
			if (command !== "crit") {
				await options.duringProcess?.({ fixture, args });
				if (args.includes("diff")) child.stdout.write("M fixture.md\n");
				close(0);
				return;
			}
			try {
				await options.duringReview?.({ fixture, child });
				if (closed) return;
				child.stdout.write(options.stdout ?? "Fixture feedback\n");
				child.stderr.write(options.stderr ?? "approved: true\n");
				close(options.code ?? 0);
			} catch (error) { child.emit("error", error); close(1); }
		});
		return child;
	});
	syncBuiltinESMExports();
	const ui = new Proxy({
		theme: { fg: (_color, text) => text, bold: text => text },
		notify: message => notifications.push(message),
		setStatus: () => {},
		setWidget: () => {},
		select: async (title, items) => {
			dialogs.push({ title, items });
			if (title.startsWith("Plan submitted")) {
				assert.equal(fixture.requests.length, expectedRequestCount, "Submission must open before another model request");
				return typeof options.choice === "function" ? options.choice(items)
					: Object.hasOwn(options, "choice") ? options.choice : "Approve — leave plan mode";
			}
			assert.equal(title, "Implement with which model?", `Unexpected dialog: ${title}`);
			return items.find(item => item === (options.modelChoice ?? "tool-api-test/fake (current)"));
		},
		input: async () => "Use smaller steps",
		custom: async () => {
			assert.ok(options.contextChoice, "Unexpected custom selector");
			return options.contextChoice;
		},
	}, { get: (target, property) => target[property] ?? (() => {}) });
	try {
		fixture = await toolApiSession({
			extensions: (options.extensions ?? ["crit.ts", "plan-mode.ts"])
				.map(path => fileURLToPath(new URL(`../../../${path}`, import.meta.url))),
			entries: [{ type: "plan-mode", data: { enabled: options.planMode ?? true,
				sessionGrants: ["crit_review", "codemode", "nested_review_fixture"], sessionDenials: options.denials ?? [] } }],
			bindings: options.noUI ? {} : { uiContext: ui, mode: "tui" },
			settings: options.codemode ? { defaultTools: ["+codemode"] } : {},
			factories: [
				...(options.codemode ? [createCodemodeExtension({ mode: "on" }), pi => {
					pi.registerTool({ name: "nested_review_fixture", label: "Nested", description: "Try model-only tools", parameters: Type.Object({}),
						async execute(_id, _parameters, _signal, _update, context) {
							const results = [];
							for (const name of ["crit_review", "submit_plan"]) {
								results.push((await context.executeTool(name, name === "submit_plan" ? { path: plan } : { plan })).isError);
							}
							return { content: [{ type: "text", text: JSON.stringify(results) }], details: undefined };
						} });
				}] : []),
				...(options.alternateModel ? [pi => pi.registerProvider("alternate-test", {
					api: "tool-api-test", baseUrl: "http://invalid.test", apiKey: "offline",
					models: [{ id: "fake", name: "Alternate offline model", reasoning: false, input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 }],
				})] : []),
			],
		});
		planDirectory = join(process.env.PI_CODING_AGENT_DIR, "plans", cwdSlug(fixture.directory));
		plan = join(planDirectory, "fixture.md");
		await mkdir(planDirectory, { recursive: true });
		if (!options.missingFile) await writeFile(plan, "# Fixture plan");
		if (options.deactivateSubmission) fixture.api.setActiveTools(fixture.api.getActiveTools().filter(name => name !== "submit_plan"));
		const originalCall = fixture.call;
		fixture.call = (...arguments_) => {
			expectedRequestCount = fixture.requests.length + 1;
			return originalCall(...arguments_);
		};
		await run({ fixture, plan, dialogs, notifications, processes });
	} finally {
		try {
			await fixture?.dispose();
			if (planDirectory) await rm(planDirectory, { recursive: true, force: true });
		} finally {
			spawnMock.mock.restore();
			syncBuiltinESMExports();
		}
	}
}
