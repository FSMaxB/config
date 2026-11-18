// Background SDK-stream consumer + the failure/metadata capture that rides it.
// consumeQuery iterates one SDK query's generator and pushes events into the
// query's captured Pi stream.

import type { Model, Api } from "@earendil-works/pi-ai";
import type { AccountInfo, query } from "@anthropic-ai/claude-agent-sdk";
import { classifyClaudeFailure, rateLimitResetFromInfo, rateLimitResetMs, rateLimitTypeFromInfo } from "./claude-failure.js";
import type { ClaudeFailureKind } from "./claude-failure.js";
import { ensureTurnStarted, processAssistantMessage, processStreamEvent, updateTurnOutputModel } from "./assistant-stream.js";
import { getExtensionApi, safeNotify } from "./bridge-state.js";
import type { Config } from "./config.js";
import { debug, shortIdOrNone } from "./debug.js";
import { refusalFallbackNotice } from "./models.js";
import type { QueryContext } from "./query-state.js";
import { RATE_LIMIT_AUTO_RESUME_EVENT, RATE_LIMIT_TOKEN, formatAllowedRateLimitWarning, formatResetTimestamp, isUsageLimitMessage, uniqueNonEmptyLines } from "./rate-limit.js";
import { activeStreamIdleWatchdogs } from "./stream-idle-watchdog.js";
import { isRecord, nonEmpty, stringProperty } from "../../lib/untyped.ts";

export function emitRateLimitEvent(payload: Record<string, unknown>): void {
	try {
		getExtensionApi()?.events.emit(RATE_LIMIT_AUTO_RESUME_EVENT, payload);
	} catch {
		// Cross-extension broker is best-effort only.
	}
}

// The fastMode setting silently no-ops when Claude Code declines fast mode.
// Surface the typed fast_mode_disabled_reason (SDK 0.3.219+) once per distinct
// reason so an enabled-but-inert setting explains itself instead of looking
// broken. Module-level dedup: the same reason repeats on every init message.
let lastFastModeDisabledNoticeReason: string | undefined;

const FAST_MODE_DISABLED_REASON_TEXT: Record<string, string> = {
	disabled_by_env: "disabled by an environment variable",
	extra_usage_disabled: "extra usage is disabled for this account",
	free: "not available on the free plan",
	model_not_allowed: "not available for this model",
	network_error: "the eligibility check hit a network error",
	not_first_party: "not available for this account type",
	preference: "disabled by a Claude Code preference",
	sdk_opt_in_required: "the SDK opt-in is missing",
	unknown: "unavailable for an unknown reason",
};

function noteFastModeDisabledReason(message: object, bridgeConfig: Config): void {
	if (bridgeConfig.provider?.fastMode !== true) return;
	const reason: unknown = Reflect.get(message, "fast_mode_disabled_reason");
	// "pending" means the CLI is still deciding — not a verdict worth announcing.
	if (typeof reason !== "string" || reason === "pending") return;
	if (reason === lastFastModeDisabledNoticeReason) return;
	lastFastModeDisabledNoticeReason = reason;
	const text = FAST_MODE_DISABLED_REASON_TEXT[reason] ?? `unavailable (${reason})`;
	safeNotify(`Pi Claude: fast mode is enabled in settings but Claude Code declined it — ${text}.`, "warning");
}

/** Background consumer: iterates the SDK generator, pushing events to currentPiStream.
 *  Runs until the query ends. Per turn, the SDK yields stream_events (deltas), then
 *  an assistant message (completed blocks). On tool_use, the stream is ended by
 *  whichever path handles it first (processStreamEvent or processAssistantMessage),
 *  and the MCP handler blocks the generator until pi delivers the tool result. */
export interface ClaudeAttemptFailure {
	kind?: ClaudeFailureKind;
	message: string;
}

export interface ConsumeQueryResult {
	capturedSessionId?: string;
	failure?: ClaudeAttemptFailure;
}

// A rate-limit event is logged in part: the leading fields identify it.
const RATE_LIMIT_PREVIEW_CHARACTERS = 300;

export async function consumeQuery(
	sdkQuery: ReturnType<typeof query>,
	// The CAPTURED context of the query being consumed, never the live currentQueryContext():
	// an MCP tool can push a reentrant subagent context while this iterator is
	// suspended, and reading live state then would consult the WRONG query — a
	// recovered success could retain its failure and surface an error, or a
	// child session id could stamp the subagent's context.
	queryContext: QueryContext,
	customToolNameToPi: ReadonlyMap<string, string>,
	model: Model<Api>,
	bridgeConfig: Config,
	wasAborted: () => boolean,
	recordBillingIdentity: (info: AccountInfo) => void,
): Promise<ConsumeQueryResult> {
	let capturedSessionId: string | undefined;
	let failure: ClaudeAttemptFailure | undefined;
	let accountInfoProbe: Promise<AccountInfo> | undefined;
	const holdFailure = (next: ClaudeAttemptFailure | undefined): void => {
		failure = next;
	};

	for await (const message of sdkQuery) {
		// After an abort the loop only drains the generator: the CLI is finishing
		// its own interrupt handling (rejected tool_results, the terminal result)
		// and exits by itself. `break` would call the iterator's return(), which is
		// close(), and kill it mid-write.
		if (wasAborted()) continue;
		activeStreamIdleWatchdogs.get(queryContext)?.noteChunk();
		if (!queryContext.turnOutput) continue;
		// Only rendering needs a live Pi stream; failure metadata may arrive
		// after a tool-use turn boundary closed it.
		const streamLive = Boolean(queryContext.currentPiStream);

		switch (message.type) {
			case "stream_event":
				if (!streamLive) break;
				processStreamEvent(message, customToolNameToPi, model, queryContext);
				break;
			case "assistant": {
				if (!streamLive && !queryContext.turnSawToolCall) break;
				processAssistantMessage(message, model, customToolNameToPi, queryContext);
				break;
			}
			case "result":
				// A failure signal followed by a result whose visible output already
				// committed (e.g. the SDK's fallback-model reroute recovering after a
				// rejected rate limit) means the query ultimately SUCCEEDED: the
				// failure was informational and must neither surface an error after
				// the answer nor skip session persistence.
				if (failure && message.subtype === "success" && queryContext.committedOutput) {
					debug(`consumeQuery: clearing informational ${failure.kind ?? "unclassified"} failure — query recovered with committed output`);
					holdFailure(undefined);
				}
				if (!queryContext.turnSawStreamEvent && message.subtype === "success") {
					if (!streamLive) break;
					const text = message.result || "";
					// The no-stream-events assistant fallback may have already rendered
					// this exact text (it does not set turnSawStreamEvent) — re-pushing
					// it here is the other half of the duplicated-output bug.
					if (queryContext.turnBlocks.some((block) => block.type === "text" && block.text === text)) {
						debug("consumeQuery: result text already rendered by assistant fallback; skipping duplicate");
						break;
					}
					ensureTurnStarted(queryContext);
					queryContext.turnBlocks.push({ type: "text", text });
					const index = queryContext.turnBlocks.length - 1;
					queryContext.currentPiStream?.push({ type: "text_start", contentIndex: index, partial: queryContext.output });
					queryContext.currentPiStream?.push({ type: "text_delta", contentIndex: index, delta: text, partial: queryContext.output });
					queryContext.currentPiStream?.push({ type: "text_end", contentIndex: index, content: text, partial: queryContext.output });
				} else if (message.subtype !== "success") {
					const errorLines = Array.isArray(message.errors) ? uniqueNonEmptyLines(message.errors) : [];
					// Some CLI versions put the error text in `result`, which the SDK's error type leaves out.
					const errors = errorLines.length > 0 ? errorLines.join("\n") : nonEmpty(stringProperty(message, "result")) ?? message.subtype;
					const usageLimit = isUsageLimitMessage(message);
					holdFailure({ kind: usageLimit ? "rate-limit" : classifyClaudeFailure(errors), message: errors });
					if (usageLimit) {
						// isUsageLimitMessage matches the CLI's own usage-limit copy (SDK
						// USAGE_LIMIT_ERROR_PREFIXES). Surface it immediately, and suppress
						// the SDK's raw follow-up throw.
						queryContext.handledTerminalError = true;
						queryContext.turnOutput.stopReason = "error";
						queryContext.turnOutput.errorMessage = errors;
						queryContext.currentPiStream?.push({ type: "error", reason: "error", error: queryContext.turnOutput });
						queryContext.currentPiStream?.end();
						queryContext.currentPiStream = undefined;
					}
					// Other non-success subtypes (error_max_turns,
					// error_during_execution) surface at completion via the held
					// failure. These turns require an explicit error event instead of
					// silent completion. Session persistence and deferred replay still run.
				}
				break;
			case "system":
				if (!streamLive) break;
				if (message.subtype === "init" && message.session_id) {
					capturedSessionId = message.session_id;
					queryContext.claudeSessionId = capturedSessionId;
					noteFastModeDisabledReason(message, bridgeConfig);
					// Which login this child authenticated as is published for other
					// extensions. Nothing waits for
					// it, so it stays off the turn's critical path. The call sits
					// in an async IIFE so a synchronous throw arrives as a
					// rejection the debug line below names.
					if (!accountInfoProbe) {
						accountInfoProbe = (async () => sdkQuery.accountInfo())();
						void accountInfoProbe
							.then((info) => recordBillingIdentity(info))
							.catch((error: unknown) => debug("consumeQuery: billing identity probe rejected:", error));
					}
				} else if (message.subtype === "model_refusal_fallback") {
					const originalModel = message.original_model;
					const fallbackModel = message.fallback_model;
					updateTurnOutputModel(fallbackModel, queryContext);
					debug("consumeQuery: model_refusal_fallback", JSON.stringify({ originalModel, fallbackModel }));
					const notice = refusalFallbackNotice(originalModel, fallbackModel);
					if (notice) safeNotify(notice, "info");
				}
				break;
			case "user":
				break;
			case "rate_limit_event": {
				if (!streamLive) break;
				const info: unknown = message.rate_limit_info;
				const record = isRecord(info) ? info : undefined;
				const status = record === undefined ? undefined : stringProperty(record, "status");
				debug("consumeQuery: rate_limit_event", JSON.stringify(info).slice(0, RATE_LIMIT_PREVIEW_CHARACTERS));
				if (status === "rejected") {
					const rateLimitType = rateLimitTypeFromInfo(record);
					const resetAt = rateLimitResetFromInfo(record);
					const resetAtMs = rateLimitResetMs(record);
					const reason = `${typeof rateLimitType === "string" ? rateLimitType : "unknown"} rate limit`;
					// A rejected event may precede a successful SDK fallback. Report it
					// without holding a terminal failure until the final result arrives.
					const resetsAt = formatResetTimestamp(resetAtMs ?? resetAt);
					emitRateLimitEvent({
						model: model.id, provider: model.provider, rateLimitType, reason, resetAt,
						...(Number.isFinite(resetAtMs) ? { resetAtMs } : {}),
						source: "claude-bridge", status: "rejected",
					});
					safeNotify(`${RATE_LIMIT_TOKEN} Claude ${reason} hit — resets ${resetsAt}`, "warning");
				} else if (status === "allowed_warning") {
					const warning = formatAllowedRateLimitWarning(record);
					if (warning) safeNotify(warning, "warning");
					else debug("consumeQuery: suppressed low/ambiguous allowed_warning rate_limit_event", JSON.stringify(info).slice(0, RATE_LIMIT_PREVIEW_CHARACTERS));
				}
				break;
			}
			case "auth_status":
			case "conversation_reset":
			case "prompt_suggestion":
			case "tool_progress":
			case "tool_use_summary":
				debug("consumeQuery: unhandled SDK message type", message.type);
				break;
		}
	}

	debug(`consumeQuery: for-await loop exited, wasAborted=${wasAborted()}, capturedSessionId=${shortIdOrNone(capturedSessionId)}, failure=${failure?.kind ?? "none"}`);
	return { capturedSessionId, failure };
}
