import { randomUUID } from "node:crypto";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import type { AssistantMessage, AssistantMessageEventStream, Message, Model, Provider, SimpleStreamOptions, Tool, TranscriptContext, Api } from "@earendil-works/pi-ai";
import * as piAi from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionProjection } from "@earendil-works/pi-coding-agent";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Base64ImageSource, ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { PROVIDER_ID, messageContentToText } from "./convert.js";
import { buildModels } from "./models.js";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX } from "./skills.js";
import { extractAllToolResults as _extractAllToolResults } from "./extract-tool-results.js";
import type { McpResult } from "./extract-tool-results.js";
import { currentQueryContext, deleteQueryLane, drainStrandedToolCalls, stackDepth, pushContext, summarizeDroppedUserMessages, takeQueuedOrParkedResult, toolCallDrainCause } from "./query-state.js";
import type { DeferredUserMessage, QueryRestartRequest, QueryContext } from "./query-state.js";
import { abortRebuildReason, abortSdkQuery, closeSdkQuery, interruptSdkQuery, teardownQuery } from "./query-teardown.js";
import { abortExitGraceMs, createChildExitTracker } from "./child-exit.js";
import { loadConfig, recordProjectTrust } from "./config.js";
import { hasClaudeCredentials } from "./auth-presence.js";
import { NATIVE_PROVIDER_UNSUPPORTED_MESSAGE, buildNativeProvider, supportsNativeProvider } from "./native-provider.js";
import { createToolServer } from "./tool-server.js";
import type { BridgedTool } from "./tool-server.js";
import { modelFacingTool } from "./flat-edit.js";
import { resolveGetModels } from "./pi-ai-compat.js";
import { conversationMessages } from "./transcript.js";
import { debug, diagDump, makeCliDebugOptions, moduleInstanceId } from "./debug.js";
import { preflightClaudeExecutable, resolveClaudeExecutable } from "./claude-executable.js";
import { appendIntegrityEntry, argKeys, deleteSharedSessionLane, getExtensionApi, getSharedSession, markSessionForRebuild, recordStartedLane, reportToolResultMismatch, safeNotify, safeToolCallSummary, setExtensionApi, setPiUI, setSharedSession, takeStartedLane } from "./bridge-state.js";
import type { SessionState } from "./bridge-state.js";
import { cancelScheduledSessionPersistence, claudeSessionPairsToolCalls, conversationFingerprint, restoreSharedSessionFromPi, schedulePersistSharedSession, syncSharedSession } from "./session-persistence.js";
import { STREAM_IDLE_BACKOFF_HINT_MS, activeStreamIdleWatchdogs, buildStreamIdleTimeoutErrorMessage, createStreamIdleWatchdog, formatDurationShort, streamIdleTimeoutMsFromEnv } from "./stream-idle-watchdog.js";
import { RATE_LIMIT_TOKEN } from "./rate-limit.js";
import { mapToolArgs } from "./tool-mapping.js";
import { finalizeCurrentStream, finalizeToolUseTurnFromMcpInvocation, scheduleToolUseTurnEnd } from "./assistant-stream.js";
import { classifyClaudeFailure } from "./claude-failure.js";
import { BRIDGE_BILLING_IDENTITY, CLAUDE_BILLING_IDENTITY_SYMBOL, beginBillingIdentityAttempt, deleteBillingIdentityLane } from "./billing-identity.js";
import { registerBridgeCommands } from "./bridge-commands.js";
import { consumeQuery, emitRateLimitEvent } from "./consume-query.js";
import type { ClaudeAttemptFailure } from "./consume-query.js";
import { buildClaudeQueryOptions } from "./query-options.js";
import { findTreeResumeTarget, resolveForkPoint } from "./tree-resume.js";
import { sdkQueryFactory } from "./sdk-query.js";
import { currentRequestLaneId, runInRequestLane } from "./request-lane.js";
import { errorMessage } from "../../lib/errors.ts";
import { stringProperty } from "../../lib/untyped.ts";

// Re-exports: unit tests and downstream consumers import these from the bundle
// entry, bundle/index.js.
export { __testSetSdkQueryFactory } from "./sdk-query.js";
export { __testSetAbortExitGraceMs, __testSetSpawnClaudeCodeProcess } from "./child-exit.js";
export { resolveConfiguredEffort } from "./query-options.js";
export { classifyClaudeExecutableBytes, preflightClaudeExecutable, resolveClaudeExecutable, spawnClaudeCodeWithDiagnostics, wrapClaudeSpawnErrorForSdk, type ClaudeExecutableFileType, type ClaudeExecutablePreflightResult } from "./claude-executable.js";
export { __testGetBridgeIntegrityState, __testSetBridgeIntegrityState, INTEGRITY_CUSTOM_TYPE, appendIntegrityEntry, reportToolResultMismatch } from "./bridge-state.js";
export { CLAUDE_BRIDGE_TOOL_ISOLATION, DISALLOWED_BUILTIN_TOOLS, bridgeOnlyToolHook } from "./tool-isolation.js";
export { settingSourcesForQuery } from "./query-options.js";
export { cancelScheduledSessionPersistence, conversationFingerprint, conversationFingerprintsMatch, planIncrementalPromptBatch, restoreSharedSessionFromPi, shouldRestorePersistedBridgeEntry } from "./session-persistence.js";
export { NATIVE_PROVIDER_UNSUPPORTED_MESSAGE, buildNativeProvider, claudeAuthSourceLabel, supportsNativeProvider } from "./native-provider.js";
export { DEFAULT_STREAM_IDLE_TIMEOUT_MS, STREAM_IDLE_BACKOFF_HINT_MS, STREAM_IDLE_TIMEOUT_ENV, buildStreamIdleTimeoutErrorMessage, createStreamIdleWatchdog, streamIdleTimeoutMsFromEnv, type StreamIdleTimeoutInfo, type StreamIdleWatchdog, type StreamIdleWatchdogState } from "./stream-idle-watchdog.js";
export { ALLOWED_RATE_LIMIT_WARNING_UTILIZATION_THRESHOLD, formatAllowedRateLimitWarning, formatResetTimestamp, isUsageLimitMessage, normalizeRateLimitUtilization, resetTimestampMs, uniqueNonEmptyLines } from "./rate-limit.js";
export { isPiDispatchable, mapToolName } from "./tool-mapping.js";
export { cancelScheduledToolUseEnd, endToolUseTurn, finalizeToolUseTurnFromMcpInvocation, processAssistantMessage, processStreamEvent, reapStaleQueuedResults, scheduleToolUseTurnEnd } from "./assistant-stream.js";
export { classifyClaudeFailure, rateLimitResetFromInfo, rateLimitResetMs, rateLimitTypeFromInfo } from "./claude-failure.js";

const getModels = await resolveGetModels(piAi);
const newAssistantMessageEventStream: () => AssistantMessageEventStream = piAi.createAssistantMessageEventStream;


// Two process-global tokens govern provider registration across module reloads.
// Extensions like pi-subagents spawn a subagent that loads THIS module again as
// a fresh (non-primary) instance. Two failure modes must be prevented:
//   (1) a subagent's registerProvider() overwriting the parent's `streamSimple`
//       in the shared ModelRegistry — the parent would then deliver tool results
//       through the subagent's empty-state streamSimple and break tool pairing;
//   (2) a subagent STEALING registration ownership: if the parent loaded
//       uncredentialed and the user logged in mid-session, a later subagent load
//       would see credentialed + no-owner and claim ownership + register ITS
//       streamSimple, split-braining the shared session/ctx.
//
// PRIMARY_INSTANCE_KEY — claimed UNCONDITIONALLY (regardless of credentials) by
// the first-loaded module instance. ONLY the primary instance may ever
// register, unregister, or claim the stream guard. Non-primary instances
// (subagents) always no-op. This is the authority token; it closes (2).
//
// ACTIVE_STREAM_SIMPLE_KEY — holds the registered instance's `streamSimple`.
// Only the primary claims it, and only while a registration is live. It doubles
// as the "already registered" flag (guard === our streamSimple) and the routing
// target for reentrant subagent calls; it closes (1).
//
// Both are released on session_shutdown (incl. /reload) by releaseProviderTokens
// so the next module load starts clean. See applyProviderRegistration for the
// native (pi >=0.81) upsert flow.
const PRIMARY_INSTANCE_KEY = Symbol.for("claude-bridge:primaryInstance");
const ACTIVE_STREAM_SIMPLE_KEY = Symbol.for("claude-bridge:activeStreamSimple");
// MODELS is buildModels(getModels("anthropic")) — projection kept in models.js.
const MODELS = buildModels(getModels("anthropic"));



// Pi doesn't pass tool results directly — it appends them to the context and calls
// the provider again. Thin wrapper over extract-tool-results.js that adds per-turn
// debug logging at the extraction boundary.
function extractAllToolResults(messages: readonly Message[]): McpResult[] {
	const { results, stopIdx: stopIndex } = _extractAllToolResults(messages);
	debug(`extractAllToolResults: ${results.length} results from ${messages.length} msgs, stopped at index ${stopIndex}`);
	debug(`extractAllToolResults: all msg roles:`, messages.map((m, i) => `[${i}]${m.role}`).join(" "));
	for (let r = 0; r < results.length; r++) {
		debug(`extractAllToolResults: result[${r}] id=${results[r].toolCallId}${results[r].isError ? " ERROR" : ""} preview:`, JSON.stringify(results[r].content).slice(0, 150));
	}
	return results;
}

/** Combine one or more consecutive user messages into a single SDK prompt.
 *
 *  Representation divergence, accepted on purpose: this MERGES N pi user
 *  messages into ONE Claude user record ("\n\n"-joined), while a REBUILD
 *  (convertPiMessages in convert.ts) imports the same pi history as N separate
 *  user records. Streaming N SDKUserMessages instead would collapse N pi turns
 *  into one Pi reply with double-counted usage, so the join stays. The merged
 *  form is only ever a query's live prompt — it is never re-imported, so the
 *  two representations never meet in one session file. */
function extractUserPrompt(messages: readonly Message[]): string | undefined {
	if (messages.length === 0 || messages.some((message) => message.role !== "user")) return undefined;
	return messages.map((message) =>
		typeof message.content === "string" ? message.content : messageContentToText(message.content) || "",
	).join("\n\n");
}

/** Combine consecutive user messages as ContentBlockParam[] while preserving images.
 *  Returns null if no images — caller should fall back to the string prompt.
 *  Same N-into-1 merge as extractUserPrompt (see its comment for why). */
function extractUserPromptBlocks(messages: readonly Message[]): ContentBlockParam[] | undefined {
	if (messages.length === 0 || messages.some((message) => message.role !== "user")) return undefined;

	let hasImage = false;
	const blocks: ContentBlockParam[] = [];
	for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
		const content = messages[messageIndex].content;
		if (messageIndex > 0) blocks.push({ type: "text", text: "\n\n" });
		if (typeof content === "string") {
			if (content) blocks.push({ type: "text", text: content });
			continue;
		}
		if (!Array.isArray(content)) {
			debug(`extractUserPromptBlocks: content is ${typeof content}`);
			continue;
		}
		debug(`extractUserPromptBlocks: ${content.length} blocks, types=${content.map((block) => block.type).join(",")}`);
		for (const block of content) {
			if (block.type === "text" && block.text) {
				blocks.push({ type: "text", text: block.text });
			} else if (block.type === "image") {
				debug(`image block: mimeType=${block.mimeType}, data length=${(block.data ?? "").length}, keys=${Object.keys(block).join(",")}`);
				const mediaType = imageMediaType(block.mimeType);
				if (!block.data || !mediaType) {
					debug(`image block missing data or a supported mimeType, skipping`);
					continue;
				}
				hasImage = true;
				blocks.push({
					type: "image",
					source: { type: "base64", media_type: mediaType, data: block.data },
				});
			}
		}
	}
	return hasImage ? blocks : undefined;
}

const IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const satisfies readonly Base64ImageSource["media_type"][];

// The image types the Anthropic API accepts; any other would fail the whole request.
function imageMediaType(mimeType: string | undefined): Base64ImageSource["media_type"] | undefined {
	return IMAGE_MEDIA_TYPES.find((mediaType) => mediaType === mimeType);
}

export interface DeferredUserReplayPlan {
	// Index where the trailing consecutive user run begins (=== messages.length
	// when the context doesn't end in a user message; never below the caller's
	// capturedThrough bound).
	runStart: number;
	userMessageCount: number;
	// All trailing user messages combined into one replay prompt, or undefined
	// when there is nothing usable to replay (no trailing users, or all-empty
	// text with no image blocks).
	prompt: string | undefined;
	// Present when the run carries image blocks — the replay must send these
	// (via wrapPromptStream) or the images are silently lost.
	blocks: ContentBlockParam[] | undefined;
}

/** Plan replay of user messages pi injected mid-query (steer drain, followUp).
 *  Captures the ENTIRE trailing consecutive user run, not just the last
 *  message, but never walks below `capturedThrough`, the position a prior callback
 *  of the SAME query already captured (or deliberately held at, for an
 *  all-empty run). Without that lower bound a second mid-query steer re-planned
 *  the whole run from scratch and the first steer was queued — and delivered to
 *  Claude — twice. */
export function planDeferredUserReplay(messages: readonly Message[], capturedThrough = 0): DeferredUserReplayPlan {
	let runStart = messages.length;
	while (runStart > capturedThrough && messages[runStart - 1]?.role === "user") runStart--;
	const trailingUsers = messages.slice(runStart);
	const prompt = trailingUsers.length > 0 ? extractUserPrompt(trailingUsers) : undefined;
	const blocks = trailingUsers.length > 0 ? extractUserPromptBlocks(trailingUsers) : undefined;
	return {
		runStart,
		userMessageCount: trailingUsers.length,
		prompt: prompt?.trim() ? prompt : undefined,
		blocks,
	};
}

async function* wrapPromptStream(blocks: readonly ContentBlockParam[]): AsyncIterable<SDKUserMessage> {
	yield {
		type: "user",
		message: { role: "user", content: [...blocks] },
		parent_tool_use_id: null,
	};
}



// QueryContext + context stack live in query-state.js so tests can import
// them without activating the extension. `currentQueryContext()`, `pushContext()`, `popContext()`
// are imported at the top of this file.

export function resolveMcpTools(context: TranscriptContext, excludeToolName?: string): {
	mcpTools: Tool[];
	customToolNameToSdk: Map<string, string>;
	customToolNameToPi: Map<string, string>;
} {
	const mcpTools: Tool[] = [];
	const customToolNameToSdk = new Map<string, string>();
	const customToolNameToPi = new Map<string, string>();

	// The tool set is declared by the transcript's system messages; replaying
	// them yields what the model may call right now, including tools added or
	// removed mid-conversation.
	for (const tool of getCurrentTools(context.messages)) {
		if (tool.name === excludeToolName) continue;
		const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;
		mcpTools.push(tool);
		// Case-insensitive aliases mean two tools differing only by case would
		// silently overwrite each other's mapping — surface it if it ever happens.
		const lowerName = tool.name.toLowerCase();
		const collision = customToolNameToSdk.get(lowerName);
		if (collision !== undefined && collision !== sdkName) {
			debug(`WARNING: resolveMcpTools lowercase alias collision: ${tool.name} overwrites mapping previously held by ${collision}`);
		}
		customToolNameToSdk.set(tool.name, sdkName);
		customToolNameToSdk.set(lowerName, sdkName);
		customToolNameToPi.set(sdkName, tool.name);
		customToolNameToPi.set(sdkName.toLowerCase(), tool.name);
	}

	return { mcpTools, customToolNameToSdk, customToolNameToPi };
}

// A tool-use turn ends through the grace timer that scheduleToolUseTurnEnd arms
// (assistant-stream.ts), not at MCP handler invocation: the CLI invokes MCP
// handlers before message_delta arrives, and message_delta carries the real
// output-token count. Ending the pi stream at handler invocation would freeze
// pi's per-turn output figures at the message_start placeholders (1–7 tokens).

// Bridges pi tools to the SDK via a low-level MCP server (tool-server.ts) that
// forwards each tool's JSON Schema unchanged, except for `edit` (see flat-edit.ts). Each tool handler blocks on a
// Promise until pi delivers the tool result via streamSimple. Handlers claim
// their tool_call id by matching the actual MCP call (tool name + arguments)
// against the recorded tool_use blocks, then results are matched by ID.
// Handlers close over the captured `queryCtx`, ensuring they operate on the
// correct query's state even across pushContext/popContext calls.
function buildMcpServers(tools: readonly Tool[], queryContext: QueryContext): Record<string, ReturnType<typeof createToolServer>> | undefined {
	if (!tools.length) return undefined;
	const mcpTools: BridgedTool[] = tools.map((tool) => ({
		name: tool.name,
		...modelFacingTool(tool),
		handler: async (args?: Record<string, unknown>) => {
			const mappedArgs = mapToolArgs(tool.name, args);
			const claim = queryContext.claimToolCall(tool.name, mappedArgs);
			const toolCallId = claim.toolCallId;
			if (!toolCallId) {
				debug(`WARNING: mcp handler ${tool.name} has no toolCallId (available=${claim.available})`);
				diagDump("tool_handler_unmatched", {
					toolName: tool.name,
					argKeys: argKeys(mappedArgs),
					available: claim.available,
					turnToolCallIds: queryContext.turnToolCallIds,
					turnToolCalls: safeToolCallSummary(queryContext.turnToolCalls),
				});
				appendIntegrityEntry("tool_handler_unmatched", {
					toolName: tool.name,
					argKeys: argKeys(mappedArgs),
					available: claim.available,
					turnToolCallIds: queryContext.turnToolCallIds,
				});
				return { content: [{ type: "text", text: `Claude bridge internal error: no matching tool_call id for ${tool.name}` }], isError: true } satisfies McpResult;
			}
			if (claim.argsMismatch) {
				// Claimed anyway (sole same-name candidate). The handler now receives
				// the raw MCP arguments, so this can no longer come from Zod stripping
				// keys — only a genuine schema/validator drift reaches here, and this
				// branch is a safety net rather than the normal path.
				debug(`mcp handler: ${tool.name} [${toolCallId}] claimed sole same-name call despite args mismatch`);
				diagDump("tool_claim_args_mismatch", {
					toolName: tool.name,
					toolCallId,
					handlerArgKeys: argKeys(mappedArgs),
					recordedArgKeys: argKeys(queryContext.turnToolCalls.find((call) => call.id === toolCallId)?.arguments),
				});
			} else if (claim.match !== "tool-args" || claim.ambiguous) {
				debug(`mcp handler: ${tool.name} [${toolCallId}] claimed by ${claim.match}${claim.ambiguous ? " (ambiguous)" : ""}`);
			}
			const earlyResult = toolCallId ? takeQueuedOrParkedResult(queryContext, toolCallId) : undefined;
			if (earlyResult !== undefined) {
				queryContext.markToolResultResolved(toolCallId);
				debug(`mcp handler: ${tool.name} [${toolCallId}] → resolved from queue/parked (${queryContext.pendingResults.size} queued, ${queryContext.reapedResults.size} parked remaining)`);
				return earlyResult;
			}
			debug(`mcp handler: ${tool.name} [${toolCallId}] → waiting`);
			// Don't end the pi turn here — message_delta (real output tokens) and
			// message_stop are normally milliseconds behind this invocation. Arm the
			// grace timer instead; it force-finalizes only if they never arrive.
			scheduleToolUseTurnEnd(
				queryContext,
				() => finalizeToolUseTurnFromMcpInvocation(queryContext, toolCallId, tool.name, mappedArgs),
				`mcp-invocation:${tool.name}`,
			);
			return new Promise<McpResult>((resolve) => {
				queryContext.pendingToolCalls.set(toolCallId, {
					toolName: tool.name,
					args: mappedArgs,
					generation: queryContext.callbackGeneration,
					resolve: (result) => {
						queryContext.markToolResultResolved(toolCallId);
						resolve(result);
					},
				});
			});
		},
	}));
	return { [MCP_SERVER_NAME]: createToolServer(MCP_SERVER_NAME, mcpTools) };
}


//
// Push-based streaming with MCP tool bridge:
// 1. streamSimple starts a query() and kicks off consumeQuery() in background
// 2. consumeQuery() iterates the SDK generator, pushing events to currentPiStream
// 3. On tool_use: ends the current pi stream, nulls it out. The MCP handler
//    blocks the generator naturally — no events arrive until resolved.
// 4. Pi executes the tool and calls streamSimple again. We swap in the replacement
//    stream, resolve the MCP handler, and the generator unblocks into that stream.
//
// Note: resetTurnState clears turnSawStreamEvent while the generator may still
// have queued messages from the previous turn. This is safe because step 3 nulls
// currentPiStream, so any leftover messages hit the `!currentQueryContext().currentPiStream` guard
// in consumeQuery and are skipped before resetTurnState runs.


// Claim the primary-instance token for this module instance if unclaimed, and
// report whether this instance is the primary. First-loaded instance wins,
// UNCONDITIONALLY (before any credential check), so a later subagent load can
// never become primary and steal registration ownership.
function claimPrimaryInstance(): boolean {
	const g = processGlobals();
	if (!g[PRIMARY_INSTANCE_KEY]) g[PRIMARY_INSTANCE_KEY] = streamClaudeAgentSdk;
	return g[PRIMARY_INSTANCE_KEY] === streamClaudeAgentSdk;
}

// Release both process-global tokens this instance owns. Called on
// session_shutdown (incl. /reload) so the freshly loaded instance starts clean.
// NOTE: this does NOT unregister the provider. Each session runtime has its own
// model registry, and the next factory call registers into the new one
// (registerNativeProvider is replace-by-id); logout-hiding is the provider's own
// auth check.
function releaseProviderTokens(event: string): void {
	const g = processGlobals();
	// Billing identity is request-lane state. The shutdown handler removes its
	// one lane after this call. The process publisher remains available to
	// sibling sessions and reads the shared lane registry across reloads until a
	// new primary replaces it.
	if (g[ACTIVE_STREAM_SIMPLE_KEY] === streamClaudeAgentSdk) {
		debug(`${event}: clearing ACTIVE_STREAM_SIMPLE_KEY`);
		g[ACTIVE_STREAM_SIMPLE_KEY] = undefined;
	}
	if (g[PRIMARY_INSTANCE_KEY] === streamClaudeAgentSdk) {
		debug(`${event}: clearing PRIMARY_INSTANCE_KEY`);
		g[PRIMARY_INSTANCE_KEY] = undefined;
	}
}

// Native (pi >=0.81) provider registration. Run at extension load, on every
// session_start, and at pre-spawn.
//
// Registers UNCONDITIONALLY (once primary): credential-driven availability
// is the provider's own auth.check/resolve reporting configured-ness, so pi
// hides/shows claude-bridge models itself. What each trigger does:
//   - load: build + register the provider (queued by the loader until bindCore).
//   - session_start: re-upsert the SAME provider object, but only when the
//     credential probe answers differently than at the last upsert. pi's
//     registerNativeProvider is upsert-by-id and kicks a full, unawaited
//     model-snapshot/availability refresh; that refresh invalidates any pass
//     already in flight (pi keeps only the latest), including the awaited pass
//     pi itself runs while building a replacement session's runtime. Re-upserting
//     with nothing changed therefore only widened the window in which the
//     synchronous snapshot lacked the bridge models (plan handoffs read it right
//     after session_start). A `claude login`/logout since the last boundary
//     still flips the probe and so still re-upserts.
//   - pre-spawn: same conditional re-upsert, from the fail-fast path, so a
//     mid-session logout also flips availability at first use.
// The tokens are (re)claimed on every trigger regardless: session_shutdown
// releases them, so a skipped upsert must still leave the provider owned.
// Non-primary instances (subagents) never touch registration: pi's native
// registry REPLACES by id, so an unguarded subagent re-register would swap in
// its own streamSimple — the exact split-brain the tokens exist to prevent.
// On a pre-0.81 host the extension declines loudly (once) instead of
// registering wrongly through the legacy overload.
let nativeProviderInstance: Provider | undefined;
let notifiedNativeUnsupported = false;
// Credential-probe answer at the last upsert that reached pi.registerProvider;
// undefined until the first one into the current runtime's registry. A re-upsert
// is only worth its refresh when this changes.
let lastRegisteredCredentialed: boolean | undefined;

function applyProviderRegistration(trigger: string): void {
	const pi = getExtensionApi();
	if (!pi) { debug(`${trigger}: applyProviderRegistration skipped — no extensionApi`); return; }
	const g = processGlobals();
	const isPrimary = claimPrimaryInstance();
	if (!isPrimary) {
		debug(`${trigger}: registration noop — non-primary instance (module=${moduleInstanceId})`);
		return;
	}
	if (!supportsNativeProvider(piAi)) {
		debug(`${trigger}: host pi-ai lacks createProvider; refusing to register (module=${moduleInstanceId})`);
		if (!notifiedNativeUnsupported) {
			notifiedNativeUnsupported = true;
			safeNotify(NATIVE_PROVIDER_UNSUPPORTED_MESSAGE, "error");
		}
		return;
	}
	const credentialed = hasClaudeCredentials();
	// Claim ordering: stream guard BEFORE registerProvider so a concurrent
	// subagent can never observe a registered provider without an owner.
	g[ACTIVE_STREAM_SIMPLE_KEY] = streamClaudeAgentSdk;
	if (nativeProviderInstance && lastRegisteredCredentialed === credentialed) {
		debug(`${trigger}: native registration upsert skipped, credentialed=${credentialed} unchanged (module=${moduleInstanceId})`);
		return;
	}
	debug(`${trigger}: native registration upsert, credentialed=${credentialed} (module=${moduleInstanceId})`);
	try {
		nativeProviderInstance ??= buildNativeProvider(
			piAi,
			MODELS,
			streamClaudeAgentSdk,
			process.env,
			() => hasClaudeCredentials(),
		);
		pi.registerProvider(nativeProviderInstance);
		lastRegisteredCredentialed = credentialed;
	} catch (error) {
		// Self-heal: release ONLY the stream guard we just claimed so a later
		// re-check retries cleanly. Keep PRIMARY_INSTANCE_KEY: releasing it would
		// reopen the subagent ownership-steal window.
		if (g[ACTIVE_STREAM_SIMPLE_KEY] === streamClaudeAgentSdk) g[ACTIVE_STREAM_SIMPLE_KEY] = undefined;
		debug(`${trigger}: registerProvider threw; released stream guard for retry (kept primary):`, error);
	}
}

/** Prompt for the query that replaces one whose Pi history was replaced. Pi's
 *  whole context becomes imported history — the summary, the retained messages
 *  and the results of the tool calls that already ran — so the replacement query
 *  is only told to carry on from it. */
export const HISTORY_REPLACED_PROMPT = "The conversation above was rewritten by Pi (compaction or history navigation). It is the complete current history, including the results of every tool call that has already run. Continue the turn from there, and do not repeat a tool call whose result is already above.";

/** Pi's new context plus the continuation prompt, so the rebuild imports every
 *  message Pi holds — trailing tool results included, which keeps each one
 *  paired with its tool call and present exactly once. */
function restartContext(request: QueryRestartRequest): TranscriptContext {
	return {
		...request.context,
		messages: [...request.context.messages, { role: "user", content: HISTORY_REPLACED_PROMPT, timestamp: Date.now() }],
	};
}

/** Pi replaced the conversation's history: pi /compact and session-tree
 *  navigation (rewind / fork-at-point / branch switch) both mutate pi's messages
 *  array out from under the bridge. syncSharedSession's REUSE check would
 *  otherwise see slice(cursor) === [] (or skip entries) and keep --resume'ing a
 *  CC session that does not match pi's history; /compact in particular triggers
 *  CC's autocompact-thrashing guard. Force the next call down the REBUILD path,
 *  and mark an ACTIVE query stale so the next provider callback restarts it
 *  rather than continuing it on history Pi has thrown away.
 *
 *  Exported for the compaction-restart unit test; pi.on wires the two events. */
export function onPiHistoryReplaced(event: string): void {
	const activeSession = getSharedSession();
	const queryContext = currentQueryContext();
	// Whether THIS call requests a restart. A query with no claim on the shared
	// record — a reentrant subagent, a foreign one-shot — is running its own
	// conversation, so pi's replacement is not its history and it is never
	// restarted on it. Read here rather than off piHistoryReplaced below, which
	// outlives a query that ended without its restart.
	const running = queryContext.activeQuery !== undefined;
	const restarts = running && !queryContext.detachedFromSharedSession;
	if (running) {
		if (restarts) queryContext.piHistoryReplaced = true;
		// A restart re-imports the interrupted calls' results from pi's own
		// history, so their interruption is expected teardown rather than the
		// integrity fault an unhandled one reports.
		reportToolResultMismatch(queryContext, event, activeSession?.cwd ?? process.cwd(), { expectedInterruption: restarts });
	}
	if (activeSession) {
		debug(`${event}: marking needsRebuild on session ${activeSession.sessionId.slice(0, 8)}`);
		// A restart kills the child, which goes on flushing its jsonl: rebuilding
		// in place would race that writer, so the replacement takes a new session
		// id and leaves the old transcript alone. A compaction that kills nothing
		// has no writer to race and rebuilds in place.
		markSessionForRebuild(`pi replaced the history (${event})`, { forceRotate: restarts });
	}
}

/** After /tree navigation, replace the record with the Claude transcript
 *  position the new branch ends at, so the next turn resumes (and, when the
 *  branch ends before the transcript's tail, forks) instead of rebuilding.
 *  onPiHistoryReplaced has already marked the record for rebuild; every
 *  rejection below simply leaves that in place. A running query is left to the
 *  restart path, which rotates the session id because the killed child may
 *  still be writing. Exported for the tree-resume unit tests. */
export function adoptTreeResumeTarget(sessionManager: { buildSessionProjection(): SessionProjection; getCwd(): string }): void {
	if (currentQueryContext().activeQuery !== undefined) return;
	const target = findTreeResumeTarget(sessionManager.buildSessionProjection());
	if (typeof target === "string") {
		debug(`tree-resume: rebuilding instead (${target})`);
		return;
	}
	const cwd = getSharedSession()?.cwd ?? sessionManager.getCwd();
	const forkPoint = resolveForkPoint(target, cwd, process.env.CLAUDE_CONFIG_DIR);
	if (typeof forkPoint === "string") {
		debug(`tree-resume: rebuilding instead (${forkPoint})`);
		return;
	}
	const fingerprint = conversationFingerprint(target.conversation);
	setSharedSession({
		sessionId: target.sessionId,
		cursor: target.conversation.length,
		cwd,
		...(fingerprint ? { conversationFingerprint: fingerprint } : {}),
		...(forkPoint.isTail ? {} : { forkAt: forkPoint.uuid }),
	});
	debug(`tree-resume: session ${target.sessionId.slice(0, 8)} ${forkPoint.isTail ? "resumes at its tail" : `forks at ${forkPoint.uuid.slice(0, 8)}`}, cursor=${target.conversation.length}`);
}

/** Provider entry point. Pi calls this for each prompt and each tool result.
 *  Two cases: tool result delivery (active query) or fresh query. Exported for
 *  the rotation-stream unit tests, which drive it with a fake SDK factory. */
export function streamClaudeAgentSdk(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
	return runInRequestLane(requestLaneId(options), () => streamClaudeAgentSdkInLane(model, context, options));
}

/** Pi marks every one-shot request (compaction, branch summary, bug-report
 *  summary) with cacheRetention "none", and so does pi-web-access's answer
 *  mode. Some of them reuse the caller's session id; answer mode even runs
 *  inside a tool call of the query that owns that lane. None of them
 *  continues the session's conversation. In the session's lane, such a
 *  request is taken for a tool-result callback of the running query, and
 *  releasing the lane afterwards deletes the session's state. A private lane
 *  per request makes it an ordinary fresh query. */
function requestLaneId(options?: SimpleStreamOptions): string | undefined {
	if (options?.cacheRetention === "none") return `one-shot:${randomUUID()}`;
	return options?.sessionId;
}

function streamClaudeAgentSdkInLane(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = newAssistantMessageEventStream();
	// Every index below (cursor, prompt window, deferred replay, fingerprint)
	// is taken over the conversation; the system messages only feed the
	// prompt and tool replay.
	const conversation = conversationMessages(context.messages);
	// The lane this request runs in, for callbacks that fire OUTSIDE it: an
	// AbortSignal listener runs in the aborter's async context, not ours.
	const laneId = currentRequestLaneId();
	// Every cacheRetention "none" request runs in a private lane (see
	// requestLaneId) that nothing references once the request settles, so
	// release it then.
	const ephemeralLane = laneId !== undefined && options?.cacheRetention === "none";
	const releaseEphemeralLane = (): void => {
		if (!ephemeralLane) return;
		deleteSharedSessionLane(laneId);
		deleteQueryLane(laneId);
		deleteBillingIdentityLane(laneId);
	};

	// DEBUG: trace followUp message triggering
	const lastMsgRole = conversation[conversation.length - 1]?.role;
	// Some hosts pass the working directory along with the stream options.
	const cwd = (options ? stringProperty(options, "cwd") : undefined) ?? process.cwd();
	debug(`provider: streamClaudeAgentSdk called, activeQuery=${!!currentQueryContext().activeQuery}, lastMsgRole=${lastMsgRole}, isReentrant=${currentQueryContext().activeQuery !== undefined}`);

	// Pi appends tool results to context and calls back. Extract this turn's results
	// (everything after the last assistant message) and match against waiting MCP
	// handlers. Results that arrive before their handler get queued in pendingResults.
	if (currentQueryContext().activeQuery) {
		const queryContext = currentQueryContext();
		// Pi calls back only after the previous response stream ended, so a request
		// that arrives while it is still open does not continue this conversation:
		// another caller reused the session id. Taking over the stream would orphan
		// the stream Pi is waiting on and leave this request unanswered.
		if (queryContext.currentPiStream !== undefined) {
			debug(`provider: refusing a request (${conversation.length} message(s)) while this session's response stream is still open`);
			queueMicrotask(() => {
				stream.push({ type: "error", reason: "error", error: standaloneErrorMessage(model, "error", CONCURRENT_REQUEST_MESSAGE) });
				stream.end();
			});
			return stream;
		}
		if (queryContext.piHistoryReplaced) {
			// Pi compacted or navigated this conversation while the query ran, so the
			// query's Claude session holds history Pi has replaced. Restart from THIS
			// context instead of delivering into it: Pi's messages already carry every
			// tool call Pi executed, so the rebuilt session imports each result once
			// and no such tool runs again. The dying query's own chain performs the
			// restart, once teardown has released the query state.
			//
			// Except when the CHILD ran an unexpected foreign call Pi never sees,
			// or a foreign MCP tool it loaded from filesystem settings. Those calls are
			// never mirrored into pi's messages and their results are observed at most,
			// never recorded, so no rebuild from pi's context can carry them. Handing
			// the replacement a history missing an account-visible call, under a
			// prompt saying every result is present, invites the model to run it
			// again. Keep this query on its stale history instead, and keep the
			// marker set: pi replaced the history whether or not the bridge acts on
			// it, so the record this query writes as it ends must still say so or the
			// NEXT turn resumes the history the compaction threw away. Report the
			// refusal once, not once per remaining tool result.
			if (queryContext.childSideCalls.size > 0) {
				if (!queryContext.reportedHistoryRestartDecline) {
					queryContext.reportedHistoryRestartDecline = true;
					const names = [...new Set([...queryContext.childSideCalls.values()].map((call) => call.name))];
					debug(`provider: pi replaced this query's history, but ${queryContext.childSideCalls.size} child-executed call(s) are absent from pi's context; not restarting (${names.join(", ")})`);
					appendIntegrityEntry("history_restart_declined", { reason: "child-executed calls pi's history cannot carry", count: queryContext.childSideCalls.size, names });
				}
			} else {
				// Consumed: the pending request carries the replacement from here, and
				// persistSession reads it there.
				queryContext.piHistoryReplaced = false;
				queryContext.restartRequest = { model, context, options, stream };
				// Nothing the dying query still emits belongs to the new history.
				queryContext.currentPiStream = undefined;
				debug(`provider: pi replaced this query's history; restarting from ${conversation.length} message(s)`);
				if (queryContext.activeQuery) abortSdkQuery(queryContext.activeQuery);
				return stream;
			}
		}
		queryContext.currentPiStream = stream;
		// The query's own abort handler ends whichever stream is current, but it
		// listens only on the signal that started the query. A callback carrying
		// another signal would otherwise wait forever once that signal aborts.
		const callbackSignal = options?.signal;
		if (callbackSignal && callbackSignal !== queryContext.querySignal) {
			const endOnAbort = (): void => {
				if (queryContext.currentPiStream !== stream) return;
				queryContext.currentPiStream = undefined;
				stream.push({ type: "error", reason: "aborted", error: standaloneErrorMessage(model, "aborted", "Operation aborted") });
				stream.end();
			};
			if (callbackSignal.aborted) queueMicrotask(endOnAbort);
			else callbackSignal.addEventListener("abort", endOnAbort, { once: true });
		}
		queryContext.resetTurnState(model);
		queryContext.latestConversationFingerprint = conversationFingerprint(conversation);
		// A fresh callback separates handlers registered for settled turns from
		// ones racing this callback's own stream — the stranded drain below only
		// ever touches the former.
		queryContext.callbackGeneration += 1;
		activeStreamIdleWatchdogs.get(queryContext)?.refresh();
		const allResults = extractAllToolResults(conversation);
		debug(`provider: tool results, ${allResults.length} results, ${queryContext.pendingToolCalls.size} waiting handlers, ctx.msgs=${conversation.length}`);
		const unmatchedResultIds: string[] = [];
		for (const result of allResults) {
			const id = result.toolCallId;
			if (id && !queryContext.hasRecordedToolCall(id) && !queryContext.forwardedToolCallIds.has(id)) {
				// A forwarded id is always legitimate even after the per-message
				// records reset — Pi only answers calls it was handed (steer-split
				// results land here after a boundary wiped the turn records).
				queryContext.markToolResultUnmatched(id);
				unmatchedResultIds.push(id);
				debug(`ERROR: tool result [${id}] has no registered tool_call id; refusing to queue or deliver`);
				continue;
			}
			queryContext.markToolResultDelivered(id);
			const pending = id ? queryContext.pendingToolCalls.get(id) : undefined;
			if (id && pending) {
				queryContext.pendingToolCalls.delete(id);
				debug(`provider: resolving ${pending.toolName} [${id}]${result.isError ? " (error)" : ""}`, JSON.stringify(result.content).slice(0, 200));
				pending.resolve(result);
			} else if (id) {
				queryContext.pendingResults.set(id, result);
				debug(`provider: queued result [${id}] (${queryContext.pendingResults.size} pending)`);
			} else {
				debug(`WARNING: tool result without toolCallId, cannot match`);
			}
			if (queryContext.pendingToolCalls.size > 0 && queryContext.pendingResults.size > 0) {
				// Legitimate under staggered SDK invocation (a waiting steer-split
				// handler while a sibling's result queues) — informational only.
				debug(`note: handlers and queued results coexist: handlers=${queryContext.pendingToolCalls.size} results=${queryContext.pendingResults.size}`);
			}
		}
		if (unmatchedResultIds.length > 0) {
			const errorResult: McpResult = {
				content: [{ type: "text", text: `Claude bridge internal error: ${unmatchedResultIds.length} tool result(s) did not match any registered tool_call id. The turn was stopped to avoid delivering tool output to the wrong call. Unmatched ids: ${unmatchedResultIds.slice(0, 8).join(", ")}${unmatchedResultIds.length > 8 ? ", ..." : ""}` }],
				isError: true,
			};
			for (const [pendingId, pending] of queryContext.pendingToolCalls) {
				// The model is told these calls were stopped; an unforwarded one must
				// never be dispatched by a later replay behind that message’s back.
				if (!queryContext.forwardedToolCallIds.has(pendingId)) queryContext.deadToolCallIds.add(pendingId);
				pending.resolve(errorResult);
			}
			queryContext.pendingToolCalls.clear();
			reportToolResultMismatch(queryContext, "unmatched tool result", cwd);
		}
		if (queryContext.pendingToolCalls.size > 0) {
			// A waiting handler whose call never reached Pi can never be answered —
			// fail it now with a retryable error instead of letting the SDK await it
			// indefinitely.
			// Forwarded-but-unanswered handlers stay: steer-split batches legitimately
			// deliver their results in a later callback.
			const stranded = drainStrandedToolCalls(queryContext);
			if (stranded.length > 0) {
				const names = stranded.map((entry) => entry.toolName).join(", ");
				debug(`provider: failed ${stranded.length} stranded MCP handler(s) never forwarded to Pi: ${names}`);
				diagDump("tool_handlers_stranded", { count: stranded.length, stranded });
				appendIntegrityEntry("tool_handlers_stranded", { count: stranded.length, stranded });
				safeNotify(`Claude bridge: failed ${stranded.length} tool call(s) that never reached Pi before their turn ended (${names}). The model saw a retryable error.`, "warning");
			}
			if (queryContext.pendingToolCalls.size > 0) {
				debug(`WARNING: ${queryContext.pendingToolCalls.size} MCP handlers still waiting after delivering ${allResults.length} results`);
				safeNotify(`Claude bridge: ${queryContext.pendingToolCalls.size} tool handler(s) still waiting — provider may be stuck`, "warning");
			}
		}

		// Detect user messages (steer/followUp) that pi injected into context
		// during the active query. This happens when:
		//   - User sends a steer while a tool is executing; pi drains the steer
		//     queue at the turn boundary and appends it to context alongside the
		//     tool result, then calls the provider again.
		//   - A followUp is delivered between tool-result turns.
		// The bridge can't forward these mid-query (the SDK query is in progress),
		// so we save them for replay as continuation queries after consumeQuery ends.
		// The cursor may only advance over messages actually captured for replay:
		// claiming Claude owns a user message that was never deferred is permanent
		// silent input loss ( — only the LAST of several trailing user
		// messages was captured while the cursor skipped them all).
		let capturedThrough = conversation.length;
		if (lastMsgRole === "user") {
			// Bound the plan at this query's own captured position (latestCursor
			// Math.max-advances with every callback's capturedThrough below), so a
			// second steer callback only queues messages BEYOND what the first one
			// already owns — re-planning the whole trailing run queued the earlier
			// steer twice. latestCursor, not the shared record's
			// cursor, deliberately: it lives on this QueryContext, so it is correct
			// for reentrant and detached foreign queries too, whose contexts the
			// shared cursor does not index.
			const replay = planDeferredUserReplay(conversation, queryContext.latestCursor);
			// Image-only runs have no usable text but must still replay — capture
			// whenever EITHER form has content.
			if (replay.prompt || replay.blocks) {
				currentQueryContext().deferredUserMessages.push({ text: replay.prompt ?? "", blocks: replay.blocks ?? undefined });
				debug(`provider: deferred ${replay.userMessageCount} user message(s) for replay after query${replay.blocks ? ` (${replay.blocks.length} blocks incl. images)` : ""}: ${(replay.prompt ?? "[image-only]").slice(0, 60)}`);
			} else {
				capturedThrough = replay.runStart;
				diagDump("deferred_user_replay_skipped", {
					contextLength: conversation.length,
					runStart: replay.runStart,
					userMessageCount: replay.userMessageCount,
					messageRoles: context.messages.map((m, i) => `[${i}]${m.role}`).join(" "),
				});
			}
		}

		// Cursor may only ADVANCE, and only for a query that holds the record's
		// claim. A reentrant subagent call routed through this instance arrives
		// here with a SHORT foreign context (its own [user…] conversation, not
		// the one the cursor indexes). Writing its length would shrink the
		// parent cursor and make the next REUSE replay already-owned history.
		// The stackDepth guard covers a pushed subagent context; the detached
		// flag covers a foreign one-shot on the top-level ctx, whose GROWN
		// mid-query context could otherwise out-length the parent's cursor and
		// advance it past history Claude never saw; Math.max
		// remains the backstop for a legacy-record foreign context the
		// fingerprint guard could not classify.
		const activeSession = getSharedSession();
		if (activeSession && stackDepth() === 0 && !queryContext.detachedFromSharedSession) {
			setSharedSession({ ...activeSession, cursor: Math.max(activeSession.cursor, capturedThrough) });
		}
		queryContext.latestCursor = Math.max(queryContext.latestCursor, capturedThrough);
		return stream;
	}

	// The query is gone but pi still delivered the result. Nothing to do — just
	// emit end_turn so pi waits for the next real user message.
	const lastMessage = conversation[conversation.length - 1];
	if (lastMessage?.role === "toolResult") {
		debug(`provider: orphaned tool result after abort, emitting end_turn`);
		// The detached flag deliberately survives query end: an orphaned result
		// from a foreign one-shot indexes ITS conversation, and writing that
		// length here would move (even shrink) the parent's cursor.
		const activeSession = getSharedSession();
		if (activeSession && stackDepth() === 0 && !currentQueryContext().detachedFromSharedSession) setSharedSession({ ...activeSession, cursor: conversation.length });
		const c = currentQueryContext();  // capture current context for the microtask
		queueMicrotask(() => {
			c.resetTurnState(model);
			stream.push({ type: "done", reason: "stop", message: c.output });
			stream.end();
			releaseEphemeralLane();
		});
		return stream;
	}

	const recordBillingIdentity = beginBillingIdentityAttempt();

	// Fail-fast credential re-check (only for a fresh query — NEVER for
	// tool-result delivery of an in-flight query, handled above, where creds were
	// valid at start and failing mid-turn would break tool pairing). This bounds
	// the logout-visibility window from "next session boundary" to "first use":
	// if the normal Claude login is absent,
	// (a) re-upsert the provider (primary-only) so pi's availability recompute
	// hides the models, and (b) fail this request with a clear, actionable
	// message instead of letting the SDK spawn die with a generic error. The
	// check is cheap (existsSync + env reads only, no credential contents).
	if (!hasClaudeCredentials()) {
		try { applyProviderRegistration("pre-spawn"); } catch { /* best effort */ }
		const message = "Claude account not connected — run `claude login` and retry.";
		debug(`provider: pre-spawn credential check failed; failing fast: ${message}`);
		const errorOutput: AssistantMessage = {
			role: "assistant", content: [],
			api: model.api, provider: model.provider, model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "error", timestamp: Date.now(),
			errorMessage: message,
		};
		queueMicrotask(() => {
			stream.push({ type: "error", reason: "error", error: errorOutput });
			stream.end();
			releaseEphemeralLane();
		});
		return stream;
	}

	// 1. Determine reentrancy and push parent context if needed.
	const isReentrant = currentQueryContext().activeQuery !== undefined;
	if (isReentrant) pushContext();
	debug(`provider: fresh query setup, isReentrant=${isReentrant}, stackDepth=${stackDepth()}`);

	// 2. Fresh child context — constructor already gave us clean Maps and empty
	//    arrays. For a reused top-level context, clear explicitly.
	currentQueryContext().currentPiStream = stream;
	currentQueryContext().pendingToolCalls.clear();
	currentQueryContext().pendingResults.clear();
	currentQueryContext().reapedResults.clear();
	// Teardown flushed the previous query's calls; carrying them into this one
	// would make it look like it ran child-side calls it never ran.
	currentQueryContext().childSideCalls.clear();
	currentQueryContext().forwardedToolCallIds.clear();
	currentQueryContext().billedMessageUsage.clear();
	currentQueryContext().deadToolCallIds.clear();
	currentQueryContext().callbackGeneration = 0;
	currentQueryContext().deferredUserMessages = [];
	currentQueryContext().resetTurnState(model);
	currentQueryContext().resetToolTracking();
	currentQueryContext().latestCursor = 0;
	currentQueryContext().claudeSessionId = undefined;
	currentQueryContext().querySignal = options?.signal;
	currentQueryContext().latestConversationFingerprint = undefined;
	currentQueryContext().committedOutput = false;
	// This query is built from the context Pi holds now; only a replacement that
	// arrives while it runs makes it stale.
	currentQueryContext().piHistoryReplaced = false;
	currentQueryContext().reportedHistoryRestartDecline = false;
	// A reentrant query never claims the shared record; a foreign-conversation
	// one-shot joins it below once syncSharedSession has ruled.
	currentQueryContext().detachedFromSharedSession = isReentrant;

	const { mcpTools, customToolNameToSdk, customToolNameToPi } = resolveMcpTools(context);

	// Config + executable preflight run BEFORE syncSharedSession on purpose: the
	// sync's REBUILD path is destructive (deleteSession + createSession + save),
	// so a misconfigured executable must fail this query while the previous
	// session file is still intact.
	const bridgeConfig = loadConfig(cwd);
	const providerSettings = bridgeConfig.provider ?? {};
	const claudeExecutable = resolveClaudeExecutable(providerSettings.pathToClaudeCodeExecutable);
	const claudeExecutablePreflight = claudeExecutable ? preflightClaudeExecutable(claudeExecutable, cwd) : undefined;

	const cursorBeforeSync = getSharedSession()?.cursor ?? null;
	// A REENTRANT (subagent) query never touches the module-level shared
	// session: syncSharedSession's REBUILD path is destructive to the PARENT's
	// session file, and any resume id borrowed from the parent would splice the
	// subagent's turn into the parent's conversation of record. It runs as a
	// clean one-shot instead (Case-1 semantics — no resume, prompt is the
	// trailing message; the child session id lives in the QueryContext only).
	const syncResult = isReentrant
		? { sessionId: undefined, promptStart: conversation.length - 1 }
		: syncSharedSession(conversation, cwd, customToolNameToSdk, model.id);
	const { sessionId: resumeSessionId, promptStart, forkAt } = syncResult;
	// A FOREIGN-conversation query (conversation-fingerprint mismatch against
	// the shared record — a subagent-shaped request arriving while the parent
	// is IDLE,) also runs as a clean one-shot and gets the same
	// hands-off treatment as a reentrant one below: never persist over the
	// module-level record, never mark it for rebuild. The flag also rides the
	// QueryContext so the mismatch/abort/teardown paths that mutate the record
	// OUTSIDE this closure (reportToolResultMismatch, the cursor advances in
	// the delivery paths above) observe the same non-claim.
	const foreignContext = syncResult.foreignContext === true;
	if (foreignContext) currentQueryContext().detachedFromSharedSession = true;
	// Identity anchor stamped onto every record this outermost query persists,
	// so the record created by a Case-1 clean start is protected from the very
	// next idle-window foreign query. The prompt's anchor is the fallback: once
	// a tool-result callback has shown this query the first assistant message,
	// persistSession stamps that context's anchor instead.
	const conversationFp = isReentrant || foreignContext ? undefined : conversationFingerprint(conversation);
	const promptMessages = conversation.slice(promptStart);
	const promptBlocks = extractUserPromptBlocks(promptMessages);
	let promptText = extractUserPrompt(promptMessages) ?? "";

	// Guard: a prompt with no usable content means the last context message
	// isn't a user message (or the batch was all-empty — joined batches turn ""
	// into "\n\n", so test the trimmed text, not truthiness). The query state
	// stack should rule this out — dump diagnostics if it happens.
	if (!promptText.trim() && !promptBlocks) {
		diagDump("empty_prompt", {
			contextLength: conversation.length,
			lastMsgRole: lastMessage?.role,
			isReentrant,
			stackDepth: stackDepth(),
			activeQueryExists: currentQueryContext().activeQuery !== undefined,
			cursorBeforeSync,
			promptStart,
			promptRoles: promptMessages.map((m) => m.role).join(" "),
			sharedSession: (() => {
				const activeSession = getSharedSession();
				return activeSession ? { sessionId: activeSession.sessionId.slice(0, 8), cursor: activeSession.cursor } : null;
			})(),
			messageRoles: context.messages.map((m, i) => `[${i}]${m.role}`).join(" "),
		});
		// Recover: use a continuation prompt so the SDK doesn't send an empty text block
		promptText = "[continue]";
	}

	const prompt: string | AsyncIterable<SDKUserMessage> = promptBlocks
		? wrapPromptStream(promptBlocks)
		: promptText;
	const mcpServers = buildMcpServers(mcpTools, currentQueryContext());
	const childExits = createChildExitTracker();
	// Pure SDK query-option assembly — see buildClaudeQueryOptions for the
	// tool isolation, prompt-append, setting-source, effort, and env rationale.
	const built = buildClaudeQueryOptions({
		cwd,
		requestedModel: model,
		bridgeConfig,
		systemPrompt: getCurrentSystemPrompt(context.messages),
		tools: mcpTools,
		reasoning: options?.reasoning,
		resumeSessionId,
		forkAt,
		mcpServers,
		claudeExecutable,
		spawnClaudeCodeProcess: childExits.spawn,
	});
	const { queryOptions } = built;

	debug("provider: fresh query",
		`model=${model.id} msgs=${conversation.length} tools=${mcpTools.length}`,
		`resume=${resumeSessionId?.slice(0, 8) ?? "none"} fork=${forkAt?.slice(0, 8) ?? "none"} effort=${built.effort ?? "default"}`,
		`fallback=${built.fallbackModel ?? "none"}`,
		`sysPrompt=${built.systemPromptMode} appendSys=${built.appendSystemPrompt} promptCtx=${built.promptContextLabels.join(",") || "none"} strictMcp=true fastMode=${providerSettings.fastMode === true}`,
		`claudeExec=${claudeExecutablePreflight ? `${claudeExecutablePreflight.fileType}:${claudeExecutablePreflight.path}` : "sdk-default"}`,
		`prompt=${promptText.slice(0, 60)}${promptBlocks ? " [+images]" : ""}`);

	// 3. Start SDK query and claim it for this context
	let wasAborted = false;
	let abortDroppedSteerCount = 0;
	// The history restart re-entry feeds the callback stream that requested it.
	let reentryStream = stream;
	let streamIdleTimedOut = false;
	const sdkQuery = sdkQueryFactory({ prompt, options: queryOptions });
	currentQueryContext().activeQuery = sdkQuery;

	// 4. Capture context for abort handling (must be AFTER pushContext)
	const abortContext = currentQueryContext();
	// A reentrant (subagent) query must never write the module-level shared
	// session: its completion/failure handlers would overwrite the PARENT's
	// record with the child's session id and cursor. A foreign-conversation
	// one-shot has exactly the same non-claim on the record.
	const persistSession = (next: SessionState | undefined): void => {
		if (isReentrant || foreignContext) return;
		// A history replacement pi made while this query ran describes PI's
		// messages, not this query, so every record the query writes — this
		// turn's, a terminal failure's, a continuation's — has to keep it.
		// Dropping it lets the next sync resume history pi has thrown away, or
		// read the post-compaction context as a foreign conversation and run it
		// as a historyless one-shot. forceRotate rides along only while a
		// restart is pending, which is the case where a child was killed and may
		// still be flushing to the session jsonl.
		// Observed and not yet acted on, or already consumed into a pending
		// restart: both mean pi replaced the history after this query started.
		const restartPending = abortContext.restartRequest !== undefined;
		const replaced = next && (abortContext.piHistoryReplaced || restartPending)
			? { ...next, needsRebuild: true, rebuildReason: "pi replaced the history while the query ran", ...(restartPending ? { forceRotate: true } : {}) }
			: next;
		const conversationAnchor = conversationFp === undefined ? undefined : abortContext.latestConversationFingerprint ?? conversationFp;
		setSharedSession(replaced && conversationAnchor ? { conversationFingerprint: conversationAnchor, ...replaced } : replaced);
	};
	const markRebuildForThisQuery = (reason: string, options: { forceRotate?: boolean } = {}): void => {
		if (isReentrant || foreignContext) return;
		markSessionForRebuild(reason, options);
	};
	//  invariant: a deferred (mid-query) user message may be dropped only
	// LOUDLY — the cursor already advanced over it on the promise of replay.
	// Callers that keep a session record after a non-empty drop must persist it
	// with needsRebuild so the next turn re-imports the steers from Pi history.
	const dropDeferredUserMessages = (site: string, undelivered?: DeferredUserMessage): DeferredUserMessage[] => {
		const dropped = [...(undelivered !== undefined ? [undelivered] : []), ...abortContext.deferredUserMessages];
		abortContext.deferredUserMessages = [];
		if (dropped.length > 0) {
			diagDump("deferred_user_messages_dropped", summarizeDroppedUserMessages(site, dropped));
		}
		return dropped;
	};
	const streamIdleTimeoutMs = streamIdleTimeoutMsFromEnv();
	const streamIdleWatchdog = streamIdleTimeoutMs > 0
		? createStreamIdleWatchdog({
			getState: () => ({
				activeQuery: abortContext.activeQuery,
				currentPiStream: abortContext.currentPiStream,
				turnOutput: abortContext.turnOutput,
				turnSawStreamEvent: abortContext.turnSawStreamEvent,
				turnStarted: abortContext.turnStarted,
			}),
			onTimeout: ({ idleMs, timeoutMs }) => {
				if (streamIdleTimedOut || wasAborted || options?.signal?.aborted || abortContext.activeQuery !== sdkQuery) return;
				streamIdleTimedOut = true;
				dropDeferredUserMessages("stream-idle-timeout");
				markRebuildForThisQuery("stream idle timeout", { forceRotate: true });
				const errorMessage = buildStreamIdleTimeoutErrorMessage(timeoutMs);
				debug("provider: stream idle timeout", `model=${model.id}`, `timeout=${timeoutMs}`, `idle=${idleMs}`);
				abortContext.handledTerminalError = true;
				emitRateLimitEvent({
					idleMs,
					model: model.id,
					provider: model.provider,
					rateLimitType: "stream_idle",
					reason: "Claude Code stream idle timeout",
					retryAfterMs: STREAM_IDLE_BACKOFF_HINT_MS,
					source: "claude-bridge",
					status: "rejected",
					timeoutMs,
				});
				safeNotify(`${RATE_LIMIT_TOKEN} Claude stream idle timeout after ${formatDurationShort(timeoutMs)} — retrying via rate-limit backoff`, "warning");
				const output = abortContext.turnOutput;
				if (output) {
					output.stopReason = "error";
					output.errorMessage = errorMessage;
					Object.assign(output, {
						rateLimitType: "stream_idle",
						retryAfterMs: STREAM_IDLE_BACKOFF_HINT_MS,
						streamIdleTimeoutMs: timeoutMs,
					});
					abortContext.currentPiStream?.push({ type: "error", reason: "error", error: output });
				}
				abortContext.currentPiStream?.end();
				abortContext.currentPiStream = undefined;
				abortSdkQuery(sdkQuery);
			},
			timeoutMs: streamIdleTimeoutMs,
		})
		: undefined;
	if (streamIdleWatchdog) {
		activeStreamIdleWatchdogs.set(abortContext, streamIdleWatchdog);
		streamIdleWatchdog.refresh();
	}
	let interruptIgnored = false;
	const noteAbort = (): void => {
		wasAborted = true;
		// Prevent stale deferred messages from being replayed by parent on pop
		abortDroppedSteerCount += dropDeferredUserMessages("abort").length;
		// Rotation is decided in settleAbortedQuery once the child's exit is known;
		// this report only records whether a tool call was in flight. Waiting MCP
		// handlers are NOT drained here: the CLI cancels them itself and records a
		// rejected result for each; teardownQuery drains them once it is gone.
		reportToolResultMismatch(abortContext, "abort", cwd, { expectedInterruption: true });
		abortContext.pendingResults.clear();
	};
	// Runs in the ABORTER's async context (AbortSignal listeners do not inherit
	// AsyncLocalStorage), so re-enter this request's lane explicitly: the
	// mismatch report marks the shared record of whatever lane is current.
	const onAbort = () => runInRequestLane(laneId, () => {
		noteAbort();
		interruptSdkQuery(sdkQuery);
		void childExits.awaitExit(abortExitGraceMs).then((outcome) => {
			if (outcome !== "still-running") return;
			interruptIgnored = true;
			debug("provider: abort: Claude Code ignored the interrupt; killing it");
			closeSdkQuery(sdkQuery);
		});
	});
	if (options?.signal) {
		if (options.signal.aborted) {
			// No child to interrupt yet: kill the query outright.
			noteAbort();
			abortSdkQuery(sdkQuery);
		} else {
			options.signal.addEventListener("abort", onAbort, { once: true });
		}
	}

	const surfaceFailure = (failure: ClaudeAttemptFailure, aborted = false): void => {
		const output = abortContext.turnOutput;
		if (output) {
			output.stopReason = aborted ? "aborted" : "error";
			output.errorMessage = failure.message;
			abortContext.currentPiStream?.push({ type: "error", reason: aborted ? "aborted" : "error", error: output });
		}
		abortContext.currentPiStream?.end();
		abortContext.currentPiStream = undefined;
	};

	// Both abort endings land here: the generator finishing, or throwing the
	// error result of the interrupted turn. After an interrupt the child exits by
	// itself, and the bridge waits for that first. Once it has exited nothing can
	// race a write into its JSONL, so a turn whose child exited, whose interrupt
	// was honoured, whose transcript pairs every tool call and which dropped no
	// queued input keeps its record exactly like a completed query would: the
	// next turn resumes the same Claude session, as Claude Code itself does after
	// Esc, and the prompt cache stays warm. Anything else rebuilds, and only an
	// unconfirmed exit still rotates the session id. Pi keeps consuming our
	// stream until it ends, so waiting here cannot overlap with the next prompt.
	const settleAbortedQuery = async (capturedSessionId: string | undefined, dropSite: string): Promise<void> => {
		const childExit = await childExits.awaitExit(abortExitGraceMs);
		const droppedQueuedUserMessages = abortDroppedSteerCount + dropDeferredUserMessages(dropSite).length;
		const activeSession = getSharedSession();
		const sessionId = capturedSessionId ?? abortContext.claudeSessionId ?? activeSession?.sessionId;
		const toolCallInFlight = abortContext.reportedToolResultMismatch;
		const transcriptPairsToolCalls = toolCallInFlight && childExit === "exited" && sessionId !== undefined
			&& claudeSessionPairsToolCalls(sessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
		if (capturedSessionId === undefined && abortContext.claudeSessionId === undefined && activeSession?.forkAt) {
			markRebuildForThisQuery("aborted before the tree-navigation fork started");
			return;
		}
		const reason = abortRebuildReason({
			childExit,
			interruptIgnored,
			toolCallInFlight,
			transcriptPairsToolCalls,
			droppedQueuedUserMessages,
			hasSessionId: sessionId !== undefined,
		});
		if (reason !== undefined) {
			markRebuildForThisQuery(reason, { forceRotate: childExit === "still-running" });
			debug(`provider: abort settled with a rebuild (${reason}), rotate=${childExit === "still-running"}`);
			return;
		}
		// abortRebuildReason asks for a rebuild without a session id, so this only narrows the type.
		if (sessionId === undefined) return;
		const cursor = Math.max(conversation.length, abortContext.latestCursor, activeSession?.cursor ?? 0);
		// Every call handed to Pi during this query has a result in the Claude
		// transcript: delivered normally, or recorded as rejected by the interrupt.
		// The next turn's REUSE plan skips Pi's own results for these ids.
		const interruptedToolCallIds = [...abortContext.forwardedToolCallIds];
		debug(`provider: abort settled cleanly, keeping session=${sessionId.slice(0, 8)} for resume, cursor=${cursor}, interruptedToolCalls=${interruptedToolCallIds.length}`);
		persistSession({ sessionId, cursor, cwd, ...(interruptedToolCallIds.length > 0 ? { interruptedToolCallIds } : {}) });
	};

	// Background consumer runs until the SDK query ends.
	// The handlers below use the CAPTURED abortCtx, never the live currentQueryContext(): the two
	// only differ while a reentrant (subagent) context is pushed, and a parent
	// query CAN end in that window (abort, child process death throwing out of
	// the generator). Live-ctx handlers there mutated the subagent's turn state
	// and stream and skipped the parent's own teardown entirely.
	consumeQuery(sdkQuery, abortContext, customToolNameToPi, model, bridgeConfig, () => wasAborted, recordBillingIdentity)
		.then(async ({ capturedSessionId, failure }) => {
			debug(`provider: consumeQuery completed, stopReason=${abortContext.turnOutput?.stopReason}, failure=${failure?.kind ?? "none"}, aborted=${wasAborted}`);
			if (abortContext.restartRequest) {
				// The replacement query owns this turn's outcome. This one must not
				// surface its interruption, end a stream, or write the record: its
				// session id and cursor describe history Pi has replaced.
				debug("provider: query ended for a history restart; leaving the outcome to the replacement query");
				return;
			}
			if (streamIdleTimedOut) {
				dropDeferredUserMessages("stream-idle-timeout-completion");
				debug("provider: stream idle timeout already surfaced; skipping normal completion");
				return;
			}

			if (wasAborted || options?.signal?.aborted) {
				await settleAbortedQuery(capturedSessionId, "abort-completion");
				surfaceFailure({ message: "Operation aborted" }, true);
				return;
			}

			if (failure) {
				// Surface an explicit error — unless the usage-limit path
				// already did — and persist the session record: the child session
				// advanced through this query, so dropping it would force a full
				// rebuild next turn. But NEVER run the deferred-replay loop from
				// here — surfacing ended the Pi stream, so a continuation query's
				// output would be invisible while its tool side effects still
				// execute. Deferred user input is dropped LOUDLY, and when steers
				// were dropped the record is marked needsRebuild: the cursor already
				// advanced over them on the promise of replay, so a plain REUSE next
					// turn would silently lose them forever.
				if (!abortContext.handledTerminalError) surfaceFailure(failure);
				const droppedSteers = dropDeferredUserMessages("terminal-failure");
				const activeSession = getSharedSession();
				const failedSessionId = capturedSessionId ?? activeSession?.sessionId;
				if (failedSessionId) {
					const cursor = Math.max(conversation.length, abortContext.latestCursor, activeSession?.cursor ?? 0);
					debug(`provider: terminal failure, persisting session=${failedSessionId.slice(0, 8)}, cursor=${cursor}, droppedSteers=${droppedSteers.length}`);
					persistSession({
						sessionId: failedSessionId,
						cursor,
						cwd,
						...(droppedSteers.length > 0 ? { needsRebuild: true, rebuildReason: `${droppedSteers.length} queued user message(s) dropped at a terminal failure` } : {}),
						...(capturedSessionId === undefined && activeSession?.forkAt ? { needsRebuild: true, rebuildReason: "the tree-navigation fork never started" } : {}),
					});
				}
				return;
			}

			const activeSession = getSharedSession();
			const sessionId = capturedSessionId ?? activeSession?.sessionId;
			if (sessionId) {
				const cursor = Math.max(conversation.length, abortContext.latestCursor, activeSession?.cursor ?? 0);
				debug(`provider: query done, session=${sessionId.slice(0, 8)}, cursor=${cursor}`);
				// Fresh record on purpose: a transient mid-turn needsRebuild/forceRotate
				// must not survive a completed query and force a rebuild next turn.
				// persistSession re-adds what a pi history replacement requires.
				persistSession({
					sessionId,
					cursor,
					cwd,
					...(capturedSessionId === undefined && activeSession?.forkAt ? { needsRebuild: true, rebuildReason: "the tree-navigation fork never started" } : {}),
				});
			}

			// Only for outermost queries — reentrant (subagent) queries leave
			// deferred messages for the parent to handle after it finishes.
			try {
				while (!isReentrant && !wasAborted) {
					const steer = abortContext.deferredUserMessages.shift();
					if (steer === undefined) break;
					const steerPreview = (steer.text || "[image-only]").slice(0, 60);
					debug(`provider: replaying deferred user message: ${steerPreview}`);
					abortContext.resetTurnState(model);
					abortContext.resetToolTracking();

					// A foreign one-shot has no claim on the shared record: its steers
					// continue ITS OWN child session, never --resume the parent's.
					const resumeId = foreignContext ? capturedSessionId : getSharedSession()?.sessionId;
					if (!resumeId) {
						debug(`WARNING: no session to resume for deferred message, dropping`);
						// No record survives here (no session id), so the next turn
						// rebuilds from Pi history anyway — but the drop is still diagnosed.
						dropDeferredUserMessages("continuation-no-resume-id", steer);
						break;
					}

					const { resumeSessionAt: _resumeSessionAt, forkSession: _forkSession, ...continuationBase } = queryOptions;
					const contOptions = { ...continuationBase, resume: resumeId, ...makeCliDebugOptions("continuation") };
					// Runs carrying image blocks replay as blocks (wrapPromptStream) so
					// the images survive; text-only runs stay plain strings.
					const contQuery = sdkQueryFactory({ prompt: steer.blocks ? wrapPromptStream(steer.blocks) : steer.text, options: contOptions });
					abortContext.activeQuery = contQuery;

					debug(`provider: continuation query, model=${model.id}, resume=${resumeId.slice(0, 8)}, prompt=${steerPreview}`);

					try {
						const continuation = await consumeQuery(contQuery, abortContext, customToolNameToPi, model, bridgeConfig, () => wasAborted, recordBillingIdentity);
						// Superseded: the restart killed this attempt, so its end is not
						// an outcome to record. The replacement carries the remaining
						// steers, which pi's history holds and the rebuild imports.
						if (abortContext.restartRequest) break;
						if (continuation.failure) {
							if (!abortContext.handledTerminalError) surfaceFailure(continuation.failure);
							// The shifted steer may never have reached the child, and any
							// remaining ones certainly did not — the record must rebuild so
							// they re-import from Pi history.
							if (dropDeferredUserMessages("continuation-failure", steer).length > 0) {
								markRebuildForThisQuery("queued user messages dropped after a continuation failure");
							}
							break;
						}
						const activeSession = getSharedSession();
						const sid = continuation.capturedSessionId ?? activeSession?.sessionId;
						if (sid) {
							persistSession({ sessionId: sid, cursor: activeSession?.cursor ?? 0, cwd });
						}
					} catch (contError) {
						// Killing the child can throw out of its iterator; that is this
						// restart's own doing, not a reason to drop input the rebuild carries.
						if (abortContext.restartRequest) break;
						debug(`provider: continuation query error:`, contError);
						const continuationFailure: ClaudeAttemptFailure = {
							kind: classifyClaudeFailure(contError),
							message: contError instanceof Error ? contError.message : String(contError),
						};
						if (!abortContext.handledTerminalError) surfaceFailure(continuationFailure);
						// Apply the same rebuild rule as the failure branch above.
						if (dropDeferredUserMessages("continuation-error", steer).length > 0) {
							markRebuildForThisQuery("queued user messages dropped after a continuation error");
						}
						break;
					} finally {
						contQuery.close();
					}
				}
			} finally {
				// Guarantees restoration even if contQuery() throws synchronously
				abortContext.activeQuery = sdkQuery;
			}

			const anchorSessionId = capturedSessionId ?? abortContext.claudeSessionId;
			const anchor = anchorSessionId && abortContext.currentMessageId ? { sessionId: anchorSessionId, messageId: abortContext.currentMessageId } : undefined;
			finalizeCurrentStream(abortContext.turnOutput?.stopReason, abortContext, anchor);
		})
		.catch(async (error: unknown) => {
			debug(`provider: query error, model=${model.id}, aborted=${Boolean(options?.signal?.aborted)}, error=`, error);
			if (abortContext.restartRequest) {
				// Killed for the restart: the replacement query surfaces the outcome.
				debug("provider: query error while a history restart was pending; suppressed");
				return;
			}
			const suppressDuplicateError = abortContext.handledTerminalError || streamIdleTimedOut;
			if (wasAborted || options?.signal?.aborted) {
				// The interrupted turn ends with an error result the SDK throws on;
				// consumeQuery's return value is lost, so the id comes from the context.
				await settleAbortedQuery(abortContext.claudeSessionId, "query-error");
				if (suppressDuplicateError) return;
				surfaceFailure({ message: "Operation aborted" }, true);
				return;
			}
			// A record kept past this error with steers behind its cursor must
			// rebuild so they re-import from Pi history. (The surface path below
			// replaces the record with null, which rebuilds too.)
			if (dropDeferredUserMessages("query-error").length > 0) {
				markRebuildForThisQuery("queued user messages dropped after a query error");
			}
			if (suppressDuplicateError) {
				debug("provider: suppressing duplicate query error after terminal handling");
				return;
			}
			const failure: ClaudeAttemptFailure = {
				kind: classifyClaudeFailure(error),
				message: error instanceof Error ? error.message : String(error),
			};
			persistSession(undefined);
			surfaceFailure(failure, false);
		})
		.finally(() => {
			streamIdleWatchdog?.dispose();
			activeStreamIdleWatchdogs.delete(abortContext);
			if (options?.signal) options.signal.removeEventListener("abort", onAbort);
			const cause = toolCallDrainCause({ wasAborted, signalAborted: options?.signal?.aborted, streamIdleTimedOut });
			teardownQuery(abortContext, sdkQuery, cause, cwd, isReentrant);
			closeSdkQuery(sdkQuery);
		})
		.then(async () => {
			// Runs AFTER teardown: the replacement is
			// a fresh outermost query over Pi's new context, and its events belong to
			// the callback that observed the replacement, not to this one.
			const restart = abortContext.restartRequest;
			if (restart) {
				abortContext.restartRequest = undefined;
				reentryStream = restart.stream;
				if (wasAborted || options?.signal?.aborted || restart.options?.signal?.aborted) {
					// The request died between the restart and this teardown: rebuilding
					// the session and spawning a child the fresh-query path kills on the
					// same signal buys nothing. Terminate the callback's stream instead.
					debug("provider: abort before the history restart — terminating the stream without restarting");
					// A fresh output for THIS message: the restart branch returned before
					// resetTurnState, so turnOutput is still the message pi already holds
					// for the pre-compaction turn. Stamping "aborted" onto it would
					// rewrite a delivered turn whose tools really ran.
					abortContext.resetTurnState(restart.model);
					const output = abortContext.output;
					output.stopReason = "aborted";
					output.errorMessage = "Operation aborted";
					reentryStream.push({ type: "error", reason: "aborted", error: output });
					reentryStream.end();
					return;
				}
				debug(`provider: restarting query on replaced history, ${restart.context.messages.length} pi message(s)`);
				for await (const event of streamClaudeAgentSdk(restart.model, restartContext(restart), restart.options)) reentryStream.push(event);
				reentryStream.end();
				return;
			}
		})
		.catch((error: unknown) => {
			debug("provider: re-entry pipeline failed:", error);
			// A throw BEFORE the re-entry ran — teardown, or closing the stale query
			// — skips it, leaving reentryStream on this call's own stream, which has
			// already ended, while pi still waits on the callback stream the restart
			// was meant to feed. Take that request over so the failure reaches the
			// stream pi is holding, and clear it so nothing stale outlives this chain.
			const restart = abortContext.restartRequest;
			if (restart) {
				abortContext.restartRequest = undefined;
				reentryStream = restart.stream;
				// Same reason as the abort branch above: without a restart this
				// message would be the delivered pre-compaction turn.
				abortContext.resetTurnState(restart.model);
			}
			const output = abortContext.turnOutput;
			if (output) {
				output.stopReason = "error";
				output.errorMessage = errorMessage(error);
				reentryStream.push({ type: "error", reason: "error", error: output });
			}
			reentryStream.end();
		})
		// After teardown and any restart: nothing else reads this lane.
		.finally(releaseEphemeralLane);

	return stream;
}

const CONCURRENT_REQUEST_MESSAGE = "Claude bridge: another request for this Pi session arrived while its response stream is still open. A one-shot request must not reuse a running session's id.";

/** An error or abort outcome for a request the running query does not serve,
 *  built without touching that query's turn state. */
function standaloneErrorMessage(model: Model<Api>, stopReason: "error" | "aborted", errorMessage: string): AssistantMessage {
	return {
		role: "assistant", content: [],
		api: model.api, provider: model.provider, model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason, timestamp: Date.now(),
		errorMessage,
	};
}


export default function (pi: ExtensionAPI): void {
	setExtensionApi(pi);
	// Pi re-runs the factory for every new session runtime, but this module stays
	// cached, so the last upsert went to the previous runtime's model registry.
	// The new registry starts without the provider and must always get it.
	lastRegisteredCredentialed = undefined;
	// Disable non-essential Claude Code traffic (update checks, MCP registry, telemetry)
	process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

	const config = loadConfig(process.cwd());
	debug("loadConfig:", JSON.stringify(config));
	// Registered before the disabled early return: a bridge switched off by
	// claude-bridge.json is exactly when the settings editor has to show where
	// that value came from.
	registerBridgeCommands(pi);
	if (config.enabled === false) {
		debug("provider: disabled by configuration");
		return;
	}
	if (claimPrimaryInstance()) {
		const host = processGlobals();
		host[CLAUDE_BILLING_IDENTITY_SYMBOL] = BRIDGE_BILLING_IDENTITY;
	}

	// Reset shared (Claude) conversation state on pi session lifecycle events.
	// Registration tokens are managed separately by applyProviderRegistration
	// (load / session_start / pre-spawn) and releaseProviderTokens (shutdown), so
	// a mid-session credential flip is handled while token ownership is intact.
	const clearSession = (event: string) => {
		const activeSession = getSharedSession();
		debug(`${event}: clearing session ${activeSession?.sessionId?.slice(0, 8) ?? "none"}`);
		setSharedSession(undefined);
	};

	pi.on("session_start", (event, context) => runInRequestLane(context.sessionManager.getSessionId(), () => {
		recordStartedLane(context.sessionManager, context.sessionManager.getSessionId());
		recordProjectTrust(context);
		setPiUI(context.ui);
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
			clearSession(`session_start:${event.reason}`);
		}
		// Note: "fork" intentionally omitted from restoration. createBranchedSession
		// copies the parent's persisted bridge entries into the fork; restoring from
		// them would --resume the parent's Claude jsonl and leak conversation past the
		// fork point. Letting the first fork turn rebuild is the correct path.
		if (event.reason === "startup" || event.reason === "resume") restoreSharedSessionFromPi(context);
		// Live availability flip: re-evaluate credential presence every
		// session_start so login/logout since load is reflected without /reload.
		applyProviderRegistration(`session_start:${event.reason}`);
	}));
	pi.on("session_shutdown", (_event, context) => {
		const sessionId = takeStartedLane(context.sessionManager) ?? context.sessionManager.getSessionId();
		runInRequestLane(sessionId, () => {
			cancelScheduledSessionPersistence(context.sessionManager);
			clearSession("session_shutdown");
			releaseProviderTokens("session_shutdown");
		});
		deleteSharedSessionLane(sessionId);
		deleteQueryLane(sessionId);
		deleteBillingIdentityLane(sessionId);
	});
	pi.on("message_end", (event, context) => runInRequestLane(context.sessionManager.getSessionId(), () => {
		const { message } = event;
		if (message?.role === "assistant" && message.provider === PROVIDER_ID) schedulePersistSharedSession(context);
	}));

	// Both events replace pi's messages array out from under the bridge; see
	// onPiHistoryReplaced for what that forces.
	pi.on("session_compact", (_event, context) => runInRequestLane(context.sessionManager.getSessionId(), () => onPiHistoryReplaced("session_compact")));
	pi.on("session_tree", (_event, context) => runInRequestLane(context.sessionManager.getSessionId(), () => {
		onPiHistoryReplaced("session_tree");
		adoptTreeResumeTarget(context.sessionManager);
	}));

	//
	// Native registration (pi >=0.81): register unconditionally; the provider's
	// own auth check/resolve report whether Claude credentials exist, so pi
	// hides claude-bridge models while no account is connected and shows them
	// when one appears. session_start and pre-spawn re-upsert the provider to
	// force pi's availability recompute at those boundaries.
	//
	// applyProviderRegistration also claims the primary-instance token (first
	// load wins) and enforces the multi-instance guard: a non-primary subagent
	// reload always no-ops, so it never overwrites the parent's streamSimple nor
	// steals ownership. See PRIMARY_INSTANCE_KEY / ACTIVE_STREAM_SIMPLE_KEY.
	applyProviderRegistration("load");
}

// Process-global slots shared by every copy of this module, keyed by registered symbols; only this
// module and its siblings write them.
function processGlobals(): Record<symbol, unknown> {
	return globalThis;
}
