// Pure assembly of the Claude Agent SDK query options for one bridge query.
// Extracted from index.ts (pure move): no closures — reads config, env, and
// the provided context only.

import { type Model } from "@earendil-works/pi-ai";
import type { McpSdkServerConfigWithInstance, query, EffortLevel, SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { extractAgentsAppend } from "./agents-md.js";
import { spawnClaudeCodeWithDiagnostics } from "./claude-executable.js";
import { normalizeEffortLevel, type Config } from "./config.js";
import { CLAUDE_BRIDGE_TOOL_ISOLATION, bridgeOnlyToolHook } from "./tool-isolation.js";
import { PROVIDER_ID } from "./convert.js";
import { makeCliDebugOptions } from "./debug.js";
import { fallbackModelForPrimaryModel } from "./models.js";
import { buildPromptContextAppend } from "./prompt-context.js";
import { extractSkillsBlock, MCP_SERVER_NAME } from "./skills.js";

// --- Effort level mapping ---
// Pi reasoning levels → CC SDK effort levels

const REASONING_TO_EFFORT: Record<string, EffortLevel> = {
	minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max", max: "max",
};

function normalizeEffortOverrideModelKey(value: string): string {
	const key = value.trim().toLowerCase();
	return key.startsWith(`${PROVIDER_ID}/`) ? key.slice(PROVIDER_ID.length + 1) : key;
}

export function resolveConfiguredEffort(
	modelId: string,
	reasoningEffort: EffortLevel | undefined,
	providerConfig?: Config["provider"],
): EffortLevel | undefined {
	const target = normalizeEffortOverrideModelKey(modelId);
	for (const [key, rawEffort] of Object.entries(providerConfig?.modelEffortOverrides ?? {})) {
		const normalizedKey = normalizeEffortOverrideModelKey(key);
		if (normalizedKey !== "*" && normalizedKey !== target) continue;
		const effort = normalizeEffortLevel(rawEffort) as EffortLevel | undefined;
		if (effort) return effort;
	}
	return (normalizeEffortLevel(providerConfig?.forceEffort) as EffortLevel | undefined) ?? reasoningEffort;
}

export interface BuildClaudeQueryOptionsInput {
	cwd: string;
	/** The model Pi requested. */
	requestedModel: Model<any>;
	bridgeConfig: Config;
	systemPrompt?: string;
	/** Pi reasoning level from the stream options, if any. */
	reasoning?: string;
	resumeSessionId: string | null;
	mcpServers?: Record<string, McpSdkServerConfigWithInstance>;
	claudeExecutable?: string;
}

export interface BuiltClaudeQueryOptions {
	queryOptions: NonNullable<Parameters<typeof query>[0]["options"]>;
	// Diagnostics-ish bits the caller's debug line reports.
	appendSystemPrompt: boolean;
	promptContextLabels: string[];
	effort?: EffortLevel;
	fallbackModel?: string;
}

export function buildClaudeQueryOptions(input: BuildClaudeQueryOptionsInput): BuiltClaudeQueryOptions {
	const { cwd, requestedModel, bridgeConfig, systemPrompt, reasoning, resumeSessionId, mcpServers, claudeExecutable } = input;
	const providerSettings = bridgeConfig.provider ?? {};
	const appendSystemPrompt = providerSettings.appendSystemPrompt !== false;
	const agentsAppend = appendSystemPrompt ? extractAgentsAppend() : undefined;
	const skillsAppend = appendSystemPrompt ? extractSkillsBlock(systemPrompt) : undefined;
	const promptContextAppend = buildPromptContextAppend(cwd, bridgeConfig.promptContext ?? {});
	const appendParts = [agentsAppend, skillsAppend, promptContextAppend.text].filter((part): part is string => Boolean(part));
	const systemPromptAppend = appendParts.length > 0 ? appendParts.join("\n\n") : undefined;

	// The default prompt mode avoids filesystem settings. When users opt into
	// settings, strict MCP config still prevents auto-discovered MCP servers.
	const settingSources = settingSourcesForQuery(appendSystemPrompt, providerSettings.settingSources);
	// Prefer the model's own thinkingLevelMap when present (pi-ai 0.72+ ships
	// per-model overrides — e.g. opus-4-7 wants xhigh→xhigh, not xhigh→max).
	// Fall back to our generic table for older pi-ai or unmapped levels.
	const requestedEffort = reasoning
		? ((requestedModel as any).thinkingLevelMap?.[reasoning] as EffortLevel | undefined)
			?? REASONING_TO_EFFORT[reasoning]
		: undefined;
	const effort = resolveConfiguredEffort(requestedModel.id, requestedEffort, providerSettings);

	const extraArgs: Record<string, string | null> = {};
	// Opus 4.7 defaults thinking.display to "omitted" (empty thinking text in stream).
	// Force summarized so thinking_delta events arrive.
	// Deliberately the raw flag, NOT the typed `thinking` option: every non-disabled
	// ThinkingConfig also emits `--thinking adaptive` or `--max-thinking-tokens`
	// (verified in sdk.mjs flag mapping), so the typed form cannot set display
	// without overriding the model's thinking mode alongside our `--effort`.
	if (effort) extraArgs["thinking-display"] = "summarized";
	const fallbackModel = fallbackModelForPrimaryModel(requestedModel.id);

	// Suppress claude.ai cloud MCP servers (Figma/Canva/etc. auto-discovered via OAuth
	// when the user is logged into Anthropic). These are a separate code path from
	// filesystem MCP and are NOT blocked by --strict-mcp-config or settingSources=undefined.
	// The native CC binary gates them on env var ENABLE_CLAUDEAI_MCP_SERVERS: setting it
	// to "0"/"false"/"no"/"off" makes the loader return early before any cloud fetch.
	// DISABLE_AUTO_COMPACT=1: pi owns context-management and propagates its own
	// /compact via session_compact (see handler in the extension entry). Letting CC
	// also autocompact would double-flush the prompt cache and races pi's
		// threshold with CC's, including CC's anti-thrashing guard.
	// Manual /compact in CC still works (we never invoke it).
	const childEnv = {
		...process.env,
		ENABLE_CLAUDEAI_MCP_SERVERS: "0",
		DISABLE_AUTO_COMPACT: "1",
	};
	const queryOptions: NonNullable<Parameters<typeof query>[0]["options"]> = {
		cwd,
		model: requestedModel.id,
		permissionMode: "bypassPermissions",
		includePartialMessages: true,
		...(fallbackModel ? { fallbackModel } : {}),
		...(providerSettings.fastMode ? { settings: { fastMode: true } } : {}),
		systemPrompt: {
			type: "preset", preset: "claude_code",
			append: systemPromptAppend ? systemPromptAppend : undefined,
		},
		extraArgs,
		...(effort ? { effort } : {}),
		...(settingSources ? { settingSources } : {}),
		...(resumeSessionId ? { resume: resumeSessionId } : {}),
		...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
		spawnClaudeCodeProcess: spawnClaudeCodeWithDiagnostics,
		...makeCliDebugOptions("provider"),
		...CLAUDE_BRIDGE_TOOL_ISOLATION,
		strictMcpConfig: true,
		hooks: { PreToolUse: [{ hooks: [bridgeOnlyToolHook()] }] },
		mcpServers: mcpServers?.[MCP_SERVER_NAME] ? { [MCP_SERVER_NAME]: mcpServers[MCP_SERVER_NAME] } : {},
		env: childEnv,
	};

	return {
		queryOptions,
		appendSystemPrompt,
		promptContextLabels: promptContextAppend.labels,
		...(effort ? { effort } : {}),
		...(fallbackModel ? { fallbackModel } : {}),
	};
}

export function settingSourcesForQuery(appendSystemPrompt: boolean, configured?: SettingSource[]): SettingSource[] | undefined {
	return appendSystemPrompt ? undefined : configured ?? ["user", "project"];
}
