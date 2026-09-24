import type { HookCallback, query } from "@anthropic-ai/claude-agent-sdk";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX } from "./skills.js";

// allowedTools auto-approves permissions; visibility also needs tools: [] and
// the SDK/CLI built-in denylist. The hook is the final runtime check.
export const DISALLOWED_BUILTIN_TOOLS = [
	"Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "Bash", "Agent", "Task",
	"NotebookEdit", "EnterWorktree", "ExitWorktree",
	"CronList", "CronCreate", "CronDelete", "TeamCreate", "TeamDelete",
	"TaskOutput", "TaskStop", "SendMessage", "Skill",
	"TodoRead", "TodoWrite",
	"ListMcpResources", "ReadMcpResource",
	"WebFetch", "WebSearch",
	"AskUserQuestion", "EnterPlanMode", "ExitPlanMode",
	"ToolSearch", "ScheduleWakeup",
];

export const CLAUDE_BRIDGE_TOOL_ISOLATION = {
	tools: [] as string[],
	disallowedTools: DISALLOWED_BUILTIN_TOOLS,
	allowedTools: [`mcp__${MCP_SERVER_NAME}__*`],
} satisfies Pick<NonNullable<Parameters<typeof query>[0]["options"]>, "tools" | "allowedTools" | "disallowedTools">;

export function bridgeOnlyToolHook(): HookCallback {
	return async (input) => {
		try {
			const eventName = input.hook_event_name;
			if (typeof eventName !== "string" || !eventName) return denyTool("<unknown>");
			if (eventName !== "PreToolUse") return { continue: true };
			const name = input.tool_name;
			if (typeof name === "string" && name.startsWith(MCP_TOOL_PREFIX) && name.length > MCP_TOOL_PREFIX.length) {
				return { continue: true };
			}
			return denyTool(name);
		} catch {
			return denyTool("<unknown>");
		}
	};
}

function denyTool(name: unknown) {
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse" as const,
			permissionDecision: "deny" as const,
			permissionDecisionReason: `Tool "${typeof name === "string" ? name : "<unknown>"}" is not available; only Pi bridge tools are permitted.`,
		},
	};
}
