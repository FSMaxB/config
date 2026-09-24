import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CLAUDE_BRIDGE_TOOL_ISOLATION, DISALLOWED_BUILTIN_TOOLS, bridgeOnlyToolHook } from "../src/index.ts";
import { buildClaudeQueryOptions, settingSourcesForQuery } from "../src/query-options.ts";

describe("Claude Code tool isolation", () => {
	it("disables the Claude Code built-in base tool set", () => {
		assert.deepEqual(CLAUDE_BRIDGE_TOOL_ISOLATION.tools, []);
		assert.deepEqual(CLAUDE_BRIDGE_TOOL_ISOLATION.allowedTools, ["mcp__custom-tools__*"]);
	});

	it("guards against native Claude Code tools observed leaking into bridge context", () => {
		for (const name of ["CronList", "SendMessage", "Skill", "TaskOutput", "TaskStop", "TodoWrite", "ScheduleWakeup", "ListMcpResources", "ReadMcpResource", "ToolSearch"]) {
			assert.ok(DISALLOWED_BUILTIN_TOOLS.includes(name), `${name} should be disallowed`);
		}
	});

	it("denies every non-Pi tool, malformed input, and throwing getters", async () => {
		// arrange
		const hook = bridgeOnlyToolHook();
		const toolNames = [undefined, null, "", "Read", "ListMcpResources", "ReadMcpResource", "ToolSearch", "mcp__linear__read", "mcp__custom-tools__"];
		const throwingName = { hook_event_name: "PreToolUse", get tool_name() { throw new Error("bad getter"); } };
		const throwingEvent = { get hook_event_name() { throw new Error("bad getter"); } };
		// act
		const outputs = await Promise.all([...toolNames.map((tool_name) => hook({ hook_event_name: "PreToolUse", tool_name, tool_input: {} })), hook(null), hook({}), hook(throwingName), hook(throwingEvent)]);
		const bridged = await hook({ hook_event_name: "PreToolUse", tool_name: "mcp__custom-tools__read", tool_input: {} });
		const otherEvent = await hook({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {} });
		// assert
		assert.ok(outputs.every((output) => output.hookSpecificOutput?.permissionDecision === "deny"));
		assert.deepEqual(bridged, { continue: true });
		assert.deepEqual(otherEvent, { continue: true });
	});

	it("locks query options even when obsolete configuration and cloud env request opt-outs", async () => {
		// arrange
		const previousCloud = process.env.ENABLE_CLAUDEAI_MCP_SERVERS;
		process.env.ENABLE_CLAUDEAI_MCP_SERVERS = "1";
		const provider = { strictMcpConfig: false, enableConnectors: true, connectorWriteMode: "allow", appendSystemPrompt: false, settingSources: ["user", "project"] };
		const fakeServer = { name: "bridge", instance: {} };
		try {
			// act
			const { queryOptions } = buildClaudeQueryOptions({
				cwd: process.cwd(), requestedModel: { id: "claude-haiku-4-5" }, bridgeConfig: { provider },
				resumeSessionId: null, mcpServers: { "custom-tools": fakeServer, foreign: fakeServer },
			});
			// assert
			assert.equal(queryOptions.strictMcpConfig, true);
			assert.equal(queryOptions.env.ENABLE_CLAUDEAI_MCP_SERVERS, "0");
			assert.equal(queryOptions.env.DISABLE_AUTO_COMPACT, "1");
			assert.deepEqual(queryOptions.tools, []);
			assert.deepEqual(queryOptions.allowedTools, ["mcp__custom-tools__*"]);
			assert.deepEqual(Object.keys(queryOptions.mcpServers), ["custom-tools"]);
			assert.deepEqual(queryOptions.settingSources, ["user", "project"]);
			assert.equal(queryOptions.hooks.PreToolUse[0].hooks.length, 1);
			const denied = await queryOptions.hooks.PreToolUse[0].hooks[0]({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} });
			assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
		} finally {
			if (previousCloud === undefined) delete process.env.ENABLE_CLAUDEAI_MCP_SERVERS;
			else process.env.ENABLE_CLAUDEAI_MCP_SERVERS = previousCloud;
		}
	});

	it("keeps default settings-source isolation unless prompt append is disabled", () => {
		// arrange
		const configured = ["user", "local"];
		// act
		const isolated = settingSourcesForQuery(true, configured);
		const defaultSources = settingSourcesForQuery(false);
		const explicit = settingSourcesForQuery(false, configured);
		// assert
		assert.equal(isolated, undefined);
		assert.deepEqual(defaultSources, ["user", "project"]);
		assert.deepEqual(explicit, configured);
	});
});
