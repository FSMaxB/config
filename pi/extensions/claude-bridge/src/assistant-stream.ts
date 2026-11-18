import { calculateCost } from "@earendil-works/pi-ai";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { appendIntegrityEntry, safeNotify } from "./bridge-state.js";
import { debug, diagDump } from "./debug.js";
import { currentQueryContext, failStrandedToolCall } from "./query-state.js";
import type { ClaudeTranscriptAnchor, QueryContext, StampedAssistantMessage } from "./query-state.js";
import { isPiDispatchable, mapToolArgs, mapToolName } from "./tool-mapping.js";


function updateUsage(output: AssistantMessage, usage: Record<string, number | undefined>, model: Model<any>, queryContext: QueryContext): void {
	// Anthropic reports per-message counters and RE-reports them as the message
	// grows, so the in-flight message's figures replace, never accumulate. What
	// accumulates is every child message already finished in this Pi turn — see
	// `turnUsageCarry` in query-state.ts for why a turn can span several. A
	// message already billed by an earlier Pi turn contributes only its increase
	// (`billedMessageUsage` in query-state.ts).
	const current = queryContext.currentMessageUsage;
	const carry = queryContext.turnUsageCarry;
	if (usage.input_tokens != null) current.input = usage.input_tokens;
	if (usage.output_tokens != null) current.output = usage.output_tokens;
	if (usage.cache_read_input_tokens != null) current.cacheRead = usage.cache_read_input_tokens;
	if (usage.cache_creation_input_tokens != null) current.cacheWrite = usage.cache_creation_input_tokens;
	const unbilled = queryContext.unbilledCurrentMessageUsage();
	output.usage.input = carry.input + unbilled.input;
	output.usage.output = carry.output + unbilled.output;
	output.usage.cacheRead = carry.cacheRead + unbilled.cacheRead;
	output.usage.cacheWrite = carry.cacheWrite + unbilled.cacheWrite;
	output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
	calculateCost(model, output.usage);
	const promptTokens = output.usage.input + output.usage.cacheRead + output.usage.cacheWrite;
	const cachePct = promptTokens > 0 ? Math.round(output.usage.cacheRead / promptTokens * 100) : 0;
	debug(`usage: in=${output.usage.input} out=${output.usage.output} cacheRead=${output.usage.cacheRead} cacheWrite=${output.usage.cacheWrite} total=${output.usage.totalTokens} cachePct=${cachePct}% model=${model.id}`);
}


function mapStopReason(reason: string | undefined): "stop" | "length" | "toolUse" {
	switch (reason) {
		case "tool_use": return "toolUse";
		case "max_tokens": return "length";
		case "end_turn": default: return "stop";
	}
}

export function parsePartialJson(input: string, fallback: Record<string, unknown>): Record<string, unknown> {
	if (!input) return fallback;
	try { return JSON.parse(input); } catch { return fallback; }
}

// Both take the query context explicitly (defaulting to the live one) so the
// completion/teardown closures in index.ts can finalize the stream of the query
// they were created for — under reentrancy the live currentQueryContext() is the subagent's.
export function ensureTurnStarted(queryContext: QueryContext = currentQueryContext()): void {
	if (!queryContext.turnStarted && queryContext.currentPiStream && queryContext.turnOutput) {
		queryContext.currentPiStream.push({ type: "start", partial: queryContext.output });
		queryContext.turnStarted = true;
	}
}

export function finalizeCurrentStream(stopReason?: string, queryContext: QueryContext = currentQueryContext(), anchor?: ClaudeTranscriptAnchor): void {
	if (!queryContext.currentPiStream || !queryContext.turnOutput) return;
	debug(`provider: finalizeCurrentStream called, stopReason=${stopReason}, turnOutput=${JSON.stringify({stopReason: queryContext.turnOutput.stopReason, error: queryContext.turnOutput.errorMessage})}`);
	if (!queryContext.turnStarted) ensureTurnStarted(queryContext);
	const reason = stopReason === "length" ? "length" : "stop";
	if (anchor) (queryContext.turnOutput as StampedAssistantMessage).claudeBridge = anchor;
	queryContext.markCurrentMessageBilled();
	queryContext.currentPiStream.push({ type: "done", reason, message: queryContext.turnOutput });
	queryContext.currentPiStream.end();
	queryContext.currentPiStream = null;
}

//
// The Claude Code CLI dispatches MCP tool calls (and the SDK yields the
// completed assistant message) BEFORE the stream's message_delta arrives — and
// message_delta is what carries the message's REAL output-token count (the
// handler fires tens of milliseconds ahead of it on every tool-use turn).
// Ending the pi stream at either of those early signals freezes usage at the
// message_start placeholder values: a handful of output tokens per tool-use
// turn while the final text turn records hundreds.
//
// So the turn ends at message_stop, exactly like the streamed-text case, and
// the early signals only ARM a grace timer. The timer is the deadlock backstop
// for a stream whose terminal events never arrive (pi's steer draining
// produces one): pi cannot execute tools before the stream ends, and the MCP
// handler cannot resolve before pi executes, so a stream that has gone silent
// must be ended by force. It fires only after TOOL_USE_END_GRACE_MS WITHOUT
// ANY stream event: a model that streams a long tool batch keeps emitting
// events past the first handler invocation, and ending the turn then prunes the
// calls that are still streaming and splits the batch across pi turns.

const TOOL_USE_END_GRACE_MS = 1500;

/** End the current pi stream as a tool_use turn boundary. Safe to call when the
 *  turn already ended (no-op). Every end path funnels here, so this is where
 *  two invariants are enforced by construction: a block still
 *  carrying partialJson never ships — Pi executes the done message's content,
 *  and truncated arguments must never execute — and every call that DOES ship
 *  is stamped forwarded so no lagging replay can dispatch it again. */
export function endToolUseTurn(queryContext: QueryContext): void {
	if (!queryContext.currentPiStream || !queryContext.turnOutput) return;
	cancelScheduledToolUseEnd(queryContext);
	const partial = (queryContext.turnOutput.content as Array<any>).filter((b) => b?.type === "toolCall" && "partialJson" in b);
	if (partial.length > 0) {
		const calls = partial.map((b) => ({ id: b.id, name: b.name }));
		debug(`endToolUseTurn: pruning ${partial.length} still-partial tool call(s) — truncated arguments never execute:`, calls.map((entry) => `${entry.name} [${entry.id}]`).join(", "));
		diagDump("partial_tool_calls_pruned", { count: partial.length, calls });
		appendIntegrityEntry("partial_tool_calls_pruned", { count: partial.length, calls });
		queryContext.turnOutput.content = (queryContext.turnOutput.content as Array<any>).filter((b) => !(b?.type === "toolCall" && "partialJson" in b));
	}
	// Every tool call Pi is about to execute from this turn is owed a result and
	// must never be dispatched again: a lagging stream replays the same tool_use
	// into the NEXT turn, whose per-message dedup cannot see it.
	for (const block of queryContext.turnOutput.content as Array<{ type?: string; id?: unknown }>) {
		if (block?.type === "toolCall" && typeof block.id === "string") queryContext.forwardedToolCallIds.add(block.id);
	}
	queryContext.turnOutput.stopReason = "toolUse";
	queryContext.markCurrentMessageBilled();
	queryContext.currentPiStream.push({ type: "done", reason: "toolUse", message: queryContext.turnOutput });
	queryContext.currentPiStream.end();
	queryContext.currentPiStream = null;
}

export function cancelScheduledToolUseEnd(queryContext: QueryContext): void {
	if (!queryContext.scheduledToolUseEnd) return;
	clearTimeout(queryContext.scheduledToolUseEnd.timer);
	queryContext.scheduledToolUseEnd = null;
}

/**
 * Arm the grace timer that force-ends the current tool_use turn if the stream
 * goes silent. First arming per stream wins; every stream event postpones it
 * (postponeToolUseTurnEnd); message_stop (or resetTurnState) disarms it.
 * `action` runs only if the SAME stream is still current when the grace
 * elapses — a turn that ended normally makes it a no-op.
 */
export function scheduleToolUseTurnEnd(queryContext: QueryContext, action: () => void, source: string): void {
	if (!queryContext.currentPiStream || !queryContext.turnOutput) return;
	if (queryContext.scheduledToolUseEnd?.stream === queryContext.currentPiStream) return;
	cancelScheduledToolUseEnd(queryContext);
	queryContext.scheduledToolUseEnd = armToolUseTurnEnd(queryContext, queryContext.currentPiStream, action, source);
}

/**
 * Park queued tool results whose handler has not fired by a child message
 * boundary, and say so everywhere it matters. The boundary is where stale
 * entries would start poisoning mismatch reports — but it does NOT prove the
 * handler gave up: the SDK staggers handler invocations, and handlers in a
 * parallel batch routinely fire after this point. Parked results stay
 * consumable through takeQueuedOrParkedResult; one that is never consumed
 * belongs to a call the SDK abandoned client-side (permission denial), which
 * is exactly what the notice describes.
 */
export function reapStaleQueuedResults(queryContext: QueryContext): void {
	const stale = queryContext.takeStaleQueuedResults();
	if (stale.length === 0) return;
	const names = stale.map((entry) => entry.toolName);
	debug(`reapStaleQueuedResults: parked ${stale.length} early tool result(s) awaiting a late handler:`, names.join(", "));
	diagDump("stale_queued_tool_results_parked", { count: stale.length, stale });
	appendIntegrityEntry("stale_queued_tool_results_parked", { count: stale.length, stale });
	safeNotify(
		`queued-results-parked=${JSON.stringify({ count: stale.length, tools: names })}\n` +
		`Claude bridge: parked ${stale.length} early tool result(s) whose handler has not arrived (${names.slice(0, 6).join(", ")}${names.length > 6 ? ", …" : ""}). ` +
		`A late handler can still consume them.`,
		"warning",
	);
}

export function updateTurnOutputModel(modelId: unknown, queryContext: QueryContext = currentQueryContext()): void {
	if (typeof modelId !== "string" || !modelId || !queryContext.turnOutput) return;
	if (queryContext.turnOutput.model === modelId) return;
	debug(`provider: active Claude model changed ${queryContext.turnOutput.model} -> ${modelId}`);
	queryContext.turnOutput.model = modelId;
}

export const FINALIZE_MAX_REARMS = 3;

/** Force-finalizes the current pi turn as a tool_use boundary when its terminal
 *  stream events never arrived (the grace-timer action armed by an MCP handler
 *  invocation — see scheduleToolUseTurnEnd).
 *
 *  The producer is pi's steer draining (tool result and drained steer arrive
 *  in one provider call): the NEXT tool turn's tool_use streams in, the SDK
 *  invokes the MCP handler — and neither terminal event ever arrives. The
 *  invocation itself proves the assistant turn is committed, so end the pi
 *  stream like the `message_stop` path — with this handler's schema-validated
 *  arguments, never a partial parse — after settling every sibling whose
 *  handler has fired and giving a merely-lagging stream up to
 *  FINALIZE_MAX_REARMS extra grace periods for the rest.
 *
 *  The dead-stream guard is a backstop: the grace timer's own stream-identity
 *  check means this normally never runs after the turn ended. The primary
 *  recovery for a handler whose call missed its turn is the generation-guarded
 *  drainStrandedToolCalls at the next provider callback. */
export function finalizeToolUseTurnFromMcpInvocation(
	queryContext: QueryContext,
	toolCallId: string,
	toolName: string,
	mappedArgs: Record<string, unknown>,
	rearmCount = 0,
): void {
	if (!queryContext.currentPiStream || !queryContext.turnOutput) {
		// The turn ended without this call. An unforwarded handler here can never
		// be answered — the yield that could have replayed its call was consumed
		// against a null stream, and the dead-mark below suppresses any replay
		// that has not happened yet. Failing it here turns what would be a
		// session-long deadlock into one retryable error.
		if (failStrandedToolCall(queryContext, toolCallId)) {
			debug(`mcp handler: ${toolName} [${toolCallId}] stranded — turn ended before its call reached Pi; resolved with error`);
			diagDump("tool_handler_stranded", { toolCallId, toolName, site: "finalize-no-stream" });
			appendIntegrityEntry("tool_handler_stranded", { toolCallId, toolName, site: "finalize-no-stream" });
		}
		return;
	}
	let index = queryContext.turnBlocks.findIndex((b: any) => b.type === "toolCall" && b.id === toolCallId);
	if (index >= 0) {
		const block = queryContext.turnBlocks[index] as any;
		if ("partialJson" in block) {
			// Stream ended before content_block_stop. The SDK invoked this handler
			// with the COMPLETE schema-validated input, so the handler's copy is
			// authoritative — the streamed partial JSON is by definition behind it.
			// Settling from the partial forwards `{}`-argument calls that Pi then
			// executes and errors on, a divergence the synthesize branch below
			// cannot have.
			block.arguments = mappedArgs;
			queryContext.updateToolCallArgs(block.id, block.arguments);
			delete block.partialJson;
			delete block.index;
			queryContext.currentPiStream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: queryContext.output });
		}
	} else if (queryContext.forwardedToolCallIds.has(toolCallId) || queryContext.deadToolCallIds.has(toolCallId)) {
		// Pi already executed this call in a turn that has ended (its result
		// arrives or sits parked), or the handler was already failed — either
		// way a second dispatch is the one outcome worse than waiting. Do NOT
		// return: this firing consumed the stream's only grace timer, so the
		// current turn's own blocks must still be settled and the turn still
		// ended below, or a turn that loses its terminal events afterwards has
		// no backstop left and Pi sits busy until manual abort.
		debug(`mcp handler: ${toolName} [${toolCallId}] already ${queryContext.forwardedToolCallIds.has(toolCallId) ? "forwarded" : "dead"} — not re-emitting`);
	} else {
		// The invocation can arrive before the tool_use is streamed at all
		// (observed after a tool-result+steer provider call reset the turn):
		// synthesize the toolCall from the claim — the MCP call carries the
		// authoritative id, name, and arguments.
		queryContext.turnBlocks.push({ type: "toolCall", id: toolCallId, name: toolName, arguments: mappedArgs });
		index = queryContext.turnBlocks.length - 1;
		const block = queryContext.turnBlocks[index] as any;
		queryContext.currentPiStream.push({ type: "toolcall_start", contentIndex: index, partial: queryContext.output });
		queryContext.currentPiStream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: queryContext.output });
	}
	// Settle every OTHER still-partial block whose handler has fired: each
	// waiting handler carries the authoritative args for its own call.
	for (let i = 0; i < queryContext.turnBlocks.length; i++) {
		const sibling = queryContext.turnBlocks[i] as any;
		if (sibling.type !== "toolCall" || !("partialJson" in sibling)) continue;
		const waiting = queryContext.pendingToolCalls.get(sibling.id);
		if (!waiting) continue;
		sibling.arguments = waiting.args;
		queryContext.updateToolCallArgs(sibling.id, sibling.arguments);
		delete sibling.partialJson;
		delete sibling.index;
		queryContext.currentPiStream.push({ type: "toolcall_end", contentIndex: i, toolCall: sibling, partial: queryContext.output });
	}
	// A block still partial here has NO fired handler: its complete arguments
	// exist nowhere on this side of the boundary yet. Ending the turn now would
	// hand Pi truncated arguments to execute — a truncated bash command is not a
	// hypothetical hazard — so give the lagging stream more grace first.
	const unsettled = queryContext.turnBlocks.filter((b: any) => b.type === "toolCall" && "partialJson" in b);
	if (unsettled.length > 0 && rearmCount < FINALIZE_MAX_REARMS) {
		debug(`mcp handler: ${unsettled.length} sibling tool call(s) still streaming — re-arming grace (${rearmCount + 1}/${FINALIZE_MAX_REARMS})`);
		scheduleToolUseTurnEnd(
			queryContext,
			() => finalizeToolUseTurnFromMcpInvocation(queryContext, toolCallId, toolName, mappedArgs, rearmCount + 1),
			`finalize-rearm:${toolName}`,
		);
		return;
	}
	// Grace exhausted with blocks still partial: endToolUseTurn prunes them —
	// truncated arguments never execute; each pruned call replays complete on
	// the SDK's assistant yield in a later turn, or its handler eventually
	// fires and the stranded drain fails it with a retryable error. When the
	// turn holds NOTHING executable (this call suppressed as forwarded/dead and
	// no settled siblings), leave the stream to its own terminal events — an
	// empty tool_use turn would make Pi execute nothing and record an empty
	// assistant message for it.
	const executable = queryContext.turnBlocks.some((b: any) => b.type === "toolCall" && !("partialJson" in b));
	if (!executable) {
		debug(`mcp handler: nothing executable in this turn after suppression — leaving the stream to its own terminal events (${toolName} [${toolCallId}])`);
		return;
	}
	queryContext.turnSawToolCall = true;
	debug(`mcp handler: finalizing tool_use turn from MCP invocation [${toolCallId}] (${toolName}) — terminal stream events never arrived`);
	endToolUseTurn(queryContext);
}

/** Maps Anthropic stream events to pi stream events (text, thinking, toolcall).
 *  On message_stop with tool_use: ends currentPiStream so pi can execute the tool. */
export function processStreamEvent(
	message: SDKMessage,
	customToolNameToPi: ReadonlyMap<string, string>,
	model: Model<any>,
	// The consuming query's CAPTURED context, never the live currentQueryContext() (see the
	// note in consumeQuery): a reentrant subagent can be pushed while the parent
	// iterator is suspended, and live-state reads would hit the wrong query.
	queryContext: QueryContext = currentQueryContext(),
): void {
	if (!queryContext.currentPiStream || !queryContext.turnOutput) return;
	const event = (message as SDKMessage & { event: any }).event;
	if (event?.type === "ping") return;
	// Any event proves the stream is alive, matched or not (the completed-message
	// yield strips block indexes, so later content_block_stop events show up as
	// unmatched): the grace timer exists for streams that go silent, not for slow
	// ones. Pings are excluded so a keep-alive can never hold a dead turn open.
	postponeToolUseTurnEnd(queryContext);
	if (event?.type === "message_stop" && !queryContext.turnSawToolCall) {
		debug("processStreamEvent: ignoring bare message_stop with no streamed content/tool call");
		return;
	}

	if (event?.type === "message_start") {
		// The child moving on to another message is where a still-queued result
		// would start poisoning mismatch reports: park it, consumable by a late
		// handler (see reapStaleQueuedResults).
		reapStaleQueuedResults(queryContext);
		queryContext.resetToolTracking();
		// Another child message begins: bank what the previous one billed before
		// its counters are replaced. No-op on the turn's first, and no-op if this
		// same message was already declared (see beginChildMessage).
		queryContext.beginChildMessage(event.message?.id);
		updateTurnOutputModel(event.message?.model, queryContext);
		if (event.message?.usage) updateUsage(queryContext.turnOutput, event.message.usage, model, queryContext);
		return;
	}

	if (event?.type === "content_block_start") {
		queryContext.turnSawStreamEvent = true;
		ensureTurnStarted(queryContext);
		// This block owns its index from here on, so release any child-executed
		// or suppressed claim on it. Belt-and-braces against a missed
		// message_start: without this a stale index could silently swallow a later
		// text block's deltas.
		queryContext.suppressedStreamIndexes.delete(event.index);
		if (event.content_block?.type === "tool_use" && !isPiDispatchable(event.content_block.name, customToolNameToPi)) {
			queryContext.suppressedStreamIndexes.add(event.index);
			queryContext.noteUnexpectedChildCall(event.content_block.id, event.content_block.name);
			debug(`processStreamEvent: non-dispatchable tool ${event.content_block.name} [${event.content_block.id}] — not mirrored as a Pi tool call`);
			return;
		}
		if (event.content_block?.type === "text") {
			queryContext.turnBlocks.push({ type: "text", text: "", index: event.index });
			queryContext.currentPiStream!.push({ type: "text_start", contentIndex: queryContext.turnBlocks.length - 1, partial: queryContext.output });
		} else if (event.content_block?.type === "thinking") {
			queryContext.turnBlocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index });
			queryContext.currentPiStream!.push({ type: "thinking_start", contentIndex: queryContext.turnBlocks.length - 1, partial: queryContext.output });
		} else if (event.content_block?.type === "tool_use") {
			const streamedId: unknown = event.content_block.id;
			if (typeof streamedId === "string" && (queryContext.forwardedToolCallIds.has(streamedId) || queryContext.deadToolCallIds.has(streamedId))) {
				// A lagging stream replaying a call Pi already executed — or one whose
				// handler was already failed as stranded — into a later turn. Mirroring
				// it would make Pi dispatch it a second time.
				queryContext.suppressedStreamIndexes.add(event.index);
				debug(`processStreamEvent: tool_use ${streamedId} already ${queryContext.forwardedToolCallIds.has(streamedId) ? "forwarded" : "dead"} — suppressing duplicate stream block`);
				return;
			}
			if (typeof streamedId === "string" && queryContext.turnBlocks.some((b: any) => b.type === "toolCall" && b.id === streamedId)) {
				// Same turn, same id: the completed-message yield beat the stream (its
				// block is already recorded with complete arguments). A second
				// partialJson copy would ship the id twice in one done message — and
				// if its stop never arrives, ship it truncated.
				queryContext.suppressedStreamIndexes.add(event.index);
				debug(`processStreamEvent: tool_use ${streamedId} already recorded in this turn — suppressing duplicate stream block`);
				return;
			}
			queryContext.turnSawToolCall = true;
			const mappedName = mapToolName(event.content_block.name, customToolNameToPi);
			queryContext.recordToolCall(event.content_block.id, mappedName, {});
			queryContext.turnBlocks.push({
				type: "toolCall", id: event.content_block.id,
				name: mappedName,
				arguments: (event.content_block.input as Record<string, unknown>) ?? {},
				partialJson: "", index: event.index,
			});
			queryContext.currentPiStream!.push({ type: "toolcall_start", contentIndex: queryContext.turnBlocks.length - 1, partial: queryContext.output });
		} else {
			debug("processStreamEvent: unhandled content_block_start type", event.content_block?.type);
		}
		return;
	}

	if (event?.type === "content_block_delta") {
		// Suppressed calls have no Pi block; their deltas are not unmatched.
		if (queryContext.suppressedStreamIndexes.has(event.index)) {
			queryContext.turnSawStreamEvent = true;
			return;
		}
		const index = queryContext.turnBlocks.findIndex((b: any) => b.index === event.index);
		const block = queryContext.turnBlocks[index];
		if (!block) {
			debug("processStreamEvent: ignoring unmatched content_block_delta", event.index);
			return;
		}
		queryContext.turnSawStreamEvent = true;
		if (event.delta?.type === "text_delta" && block.type === "text") {
			block.text += event.delta.text;
			queryContext.currentPiStream!.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: queryContext.output });
		} else if (event.delta?.type === "thinking_delta" && block.type === "thinking") {
			block.thinking += event.delta.thinking;
			queryContext.currentPiStream!.push({ type: "thinking_delta", contentIndex: index, delta: event.delta.thinking, partial: queryContext.output });
		} else if (event.delta?.type === "input_json_delta" && block.type === "toolCall") {
			block.partialJson += event.delta.partial_json;
			block.arguments = parsePartialJson(block.partialJson, block.arguments);
			queryContext.currentPiStream!.push({ type: "toolcall_delta", contentIndex: index, delta: event.delta.partial_json, partial: queryContext.output });
		} else if (event.delta?.type === "signature_delta" && block.type === "thinking") {
			block.thinkingSignature = (block.thinkingSignature ?? "") + event.delta.signature;
		} else {
			debug("processStreamEvent: unhandled content_block_delta type", event.delta?.type);
		}
		return;
	}

	if (event?.type === "content_block_stop") {
		// Same as the delta case: the block was never mirrored, so there is nothing
		// to seal and nothing unmatched about it.
		if (queryContext.suppressedStreamIndexes.has(event.index)) {
			queryContext.turnSawStreamEvent = true;
			return;
		}
		const index = queryContext.turnBlocks.findIndex((b: any) => b.index === event.index);
		const block = queryContext.turnBlocks[index];
		if (!block) {
			debug("processStreamEvent: ignoring unmatched content_block_stop", event.index);
			return;
		}
		queryContext.turnSawStreamEvent = true;
		delete block.index;
		if (block.type === "text") {
			queryContext.currentPiStream!.push({ type: "text_end", contentIndex: index, content: block.text, partial: queryContext.output });
		} else if (block.type === "thinking") {
			queryContext.currentPiStream!.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: queryContext.output });
		} else if (block.type === "toolCall") {
			queryContext.turnSawToolCall = true;
			block.arguments = mapToolArgs(
				block.name, parsePartialJson(block.partialJson, block.arguments),
			);
			queryContext.updateToolCallArgs(block.id, block.arguments);
			delete block.partialJson;
			queryContext.currentPiStream!.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: queryContext.output });
		}
		return;
	}

	if (event?.type === "message_delta") {
		queryContext.turnOutput.stopReason = mapStopReason(event.delta?.stop_reason);
		if (event.usage) updateUsage(queryContext.turnOutput, event.usage, model, queryContext);
		return;
	}

	if (event?.type === "message_stop" && queryContext.turnSawToolCall) {
		// Tool call complete — end this pi stream, disarming any grace timer the
		// MCP-invocation or assistant-boundary path armed. This is the NORMAL end
		// for a tool-use turn: message_delta already delivered the message's real
		// usage just above, so the done event carries correct output tokens. The
		// MCP handler blocks the generator until pi delivers the tool result via
		// the next streamSimple call.
		endToolUseTurn(queryContext);

		// Cursor is updated by the next streamSimple call (tool result delivery path)
		// which sets cursor = context.messages.length with the post-tool-result context.
		return;
	}

	if (event?.type !== "message_stop" && event?.type !== "ping") {
		debug("processStreamEvent: unhandled event type", event?.type);
	}
}

/** Restart an armed grace period for the CURRENT stream. Called on every stream
 *  event, so the timer only fires after TOOL_USE_END_GRACE_MS of silence. */
export function postponeToolUseTurnEnd(queryContext: QueryContext): void {
	const scheduled = queryContext.scheduledToolUseEnd;
	if (!scheduled || scheduled.stream !== queryContext.currentPiStream) return;
	clearTimeout(scheduled.timer);
	queryContext.scheduledToolUseEnd = armToolUseTurnEnd(queryContext, scheduled.stream, scheduled.action, scheduled.source);
}

function armToolUseTurnEnd(queryContext: QueryContext, stream: unknown, action: () => void, source: string): NonNullable<QueryContext["scheduledToolUseEnd"]> {
	const timer = setTimeout(() => {
		if (queryContext.currentPiStream !== stream) return;
		debug(`scheduleToolUseTurnEnd: no stream event for ${TOOL_USE_END_GRACE_MS}ms (${source}) — force-ending tool_use turn`);
		queryContext.scheduledToolUseEnd = null;
		action();
	}, TOOL_USE_END_GRACE_MS);
	timer.unref?.();
	return { stream, timer, action, source };
}

// The SDK always yields `assistant` messages (completed content blocks) after streaming.
// When stream_events already delivered the content, this is a no-op. But after
// resetTurnState (e.g. tool result delivery), if the next turn's assistant message
// arrives before any stream_events, this is the primary content path. Must maintain
// the same stream lifecycle as processStreamEvent — including ending the stream on
// tool_use to prevent deadlock with the MCP handler.
function appendMissingToolUsesFromAssistant(
	assistantMessage: { content?: Array<any>; usage?: Record<string, number | undefined> },
	model: Model<any>,
	customToolNameToPi: ReadonlyMap<string, string>,
	queryContext: QueryContext,
): boolean {
	if (!assistantMessage?.content) return false;
	// With a dead stream, ids are still RECORDED (claims and result matching
	// need them) but the content is never touched: turnBlocks IS the content
	// array of a turnOutput that endToolUseTurn already handed Pi BY REFERENCE
	// in its done event, so a push here appends calls into a delivered message
	// behind Pi's back — whether Pi's dispatch enumerates before or after the
	// push is a microtask race.
	const streamLive = Boolean(queryContext.currentPiStream && queryContext.turnOutput);
	let sawToolUse = false;
	for (const block of assistantMessage.content) {
		if (block.type !== "tool_use") continue;
		if (!isPiDispatchable(block.name, customToolNameToPi)) {
			queryContext.noteUnexpectedChildCall(block.id, block.name);
			debug(`assistant message: non-dispatchable tool ${block.name} [${block.id}] — not mirrored as a Pi tool call`);
			continue;
		}
		const existingIndex = queryContext.turnBlocks.findIndex((b: any) => b.type === "toolCall" && b.id === block.id);
		if (existingIndex < 0 && (queryContext.forwardedToolCallIds.has(block.id) || queryContext.deadToolCallIds.has(block.id))) {
			// Completed-message replay of a call Pi already executed in a turn that
			// has ended (or one already failed as stranded). Not a live Pi turn
			// boundary: sawToolUse stays false for it, and no block is emitted.
			debug(`assistant message: tool_use ${block.id} already ${queryContext.forwardedToolCallIds.has(block.id) ? "forwarded" : "dead"} — skipping duplicate`);
			continue;
		}
		sawToolUse = true;
		const name = mapToolName(block.name, customToolNameToPi);
		const mappedArgs = mapToolArgs(name, block.input);
		queryContext.recordToolCall(block.id, name, mappedArgs);
		if (!streamLive) continue;
		if (existingIndex >= 0) {
			const existing = queryContext.turnBlocks[existingIndex] as any;
			existing.name = name;
			existing.arguments = mappedArgs;
			queryContext.updateToolCallArgs(block.id, mappedArgs);
			if ("partialJson" in existing) {
				delete existing.partialJson;
				delete existing.index;
				queryContext.currentPiStream?.push({ type: "toolcall_end", contentIndex: existingIndex, toolCall: existing, partial: queryContext.output });
			}
			continue;
		}

		ensureTurnStarted(queryContext);
		queryContext.turnBlocks.push({
			type: "toolCall", id: block.id,
			name,
			arguments: mappedArgs,
		});
		const index = queryContext.turnBlocks.length - 1;
		const toolBlock = queryContext.turnBlocks[index];
		queryContext.currentPiStream?.push({ type: "toolcall_start", contentIndex: index, partial: queryContext.output });
		queryContext.currentPiStream?.push({ type: "toolcall_end", contentIndex: index, toolCall: toolBlock as any, partial: queryContext.output });
	}
	// Only while the stream is still live: the SDK's assistant yields carry the
	// message_start placeholder usage, and once the done event has delivered
	// turnOutput to pi, overwriting its usage with those placeholders would
	// corrupt the very figure message_delta got right.
	if (assistantMessage.usage && queryContext.turnOutput && queryContext.currentPiStream) updateUsage(queryContext.turnOutput, assistantMessage.usage, model, queryContext);
	return sawToolUse;
}

export function processAssistantMessage(message: SDKMessage, model: Model<any>, customToolNameToPi: ReadonlyMap<string, string>, queryContext: QueryContext = currentQueryContext()): void {
	const assistantMessage = (message as any).message;
	if (!assistantMessage?.content) return;
	updateTurnOutputModel(assistantMessage.model, queryContext);
	if (queryContext.turnSawStreamEvent) {
		// The SDK yields the completed assistant message BEFORE the stream's
		// message_delta/message_stop on every tool-use turn (the norm, not a
		// fallback). Record any tool_use blocks the stream hasn't delivered yet,
		// but do NOT end the pi stream here: message_delta, which arrives tens of
		// ms later, carries the message's real output-token count, and
		// message_stop is the normal turn end. Ending here freezes usage at the
		// message_start placeholders. The grace timer force-ends the turn if the
		// terminal events never arrive, so pi still gets to execute the tools and
		// unblock the MCP handlers.
		if (appendMissingToolUsesFromAssistant(assistantMessage, model, customToolNameToPi, queryContext)) {
			queryContext.turnSawToolCall = true;
			scheduleToolUseTurnEnd(queryContext, () => endToolUseTurn(queryContext), "assistant-boundary");
		}
		return;
	}
	// The SDK yields the SAME assistant message more than once (per-block
	// partial copies and the completed message share one id). With stream
	// events, the streamed path already renders content and the duplicates are
	// naturally ignored; on this no-stream-events path, re-rendering each
	// yield wholesale prints a rate-limited turn's "You've hit your weekly
	// limit" twice. Same-message yields keep the turn's tracking (a reset
	// mid-message would wipe live tool-claim state) and render only blocks not
	// already rendered.
	const sameMessage = typeof assistantMessage.id === "string" && assistantMessage.id.length > 0 && assistantMessage.id === queryContext.currentMessageId;
	if (!sameMessage) {
		reapStaleQueuedResults(queryContext);
		queryContext.resetToolTracking();
	}
	// The no-stream-events path also sees a message boundary. It is keyed on the
	// message ID rather than trusted blindly, because this branch is ALSO reached
	// for a message whose `message_start` already streamed — any message that
	// produced no content blocks, since `turnSawStreamEvent` only tracks those.
	queryContext.beginChildMessage(assistantMessage.id);
	debug(`processAssistantMessage fallback: ${assistantMessage.content.length} blocks, types=${assistantMessage.content.map((b: any) => b.type).join(",")}${sameMessage ? " (same message re-yield)" : ""}`);
	// Deduped against the WHOLE current turn, not just same-id re-yields: a
	// rejected turn's synthesized error message ("You've hit your weekly limit")
	// arrives as multiple assistant yields whose ids DIFFER or are absent (one
	// pi message, two byte-identical text blocks), so an id-keyed guard alone
	// still renders it twice. A model legitimately
	// producing two byte-identical full blocks in one turn is vanishingly rare;
	// rendering such a duplicate once is the better failure mode.
	const alreadyRendered = (type: string, content: string): boolean =>
		queryContext.turnBlocks.some((b: any) => b.type === type && (type === "text" ? b.text : b.thinking) === content);
	for (const block of assistantMessage.content) {
		if (block.type === "text" && block.text) {
			if (alreadyRendered("text", block.text)) continue;
			ensureTurnStarted(queryContext);
			queryContext.turnBlocks.push({ type: "text", text: block.text });
			const index = queryContext.turnBlocks.length - 1;
			queryContext.currentPiStream?.push({ type: "text_start", contentIndex: index, partial: queryContext.output });
			queryContext.currentPiStream?.push({ type: "text_delta", contentIndex: index, delta: block.text, partial: queryContext.output });
			queryContext.currentPiStream?.push({ type: "text_end", contentIndex: index, content: block.text, partial: queryContext.output });
		} else if (block.type === "thinking") {
			if (alreadyRendered("thinking", block.thinking ?? "")) continue;
			ensureTurnStarted(queryContext);
			queryContext.turnBlocks.push({ type: "thinking", thinking: block.thinking ?? "", thinkingSignature: block.signature ?? "" });
			const idx = queryContext.turnBlocks.length - 1;
			queryContext.currentPiStream?.push({ type: "thinking_start", contentIndex: idx, partial: queryContext.output });
			if (block.thinking) queryContext.currentPiStream?.push({ type: "thinking_delta", contentIndex: idx, delta: block.thinking, partial: queryContext.output });
			queryContext.currentPiStream?.push({ type: "thinking_end", contentIndex: idx, content: block.thinking ?? "", partial: queryContext.output });
		} else if (block.type === "tool_use") {
			if (!isPiDispatchable(block.name, customToolNameToPi)) {
				queryContext.noteUnexpectedChildCall(block.id, block.name);
				debug(`processAssistantMessage fallback: non-dispatchable tool ${block.name} [${block.id}] — not mirrored as a Pi tool call`);
				continue;
			}
			if (!queryContext.turnBlocks.some((b: any) => b.type === "toolCall" && b.id === block.id)
				&& (queryContext.forwardedToolCallIds.has(block.id) || queryContext.deadToolCallIds.has(block.id))) {
				// A cross-turn replay of a call Pi already executed (or one whose
				// handler was already failed as stranded). This is the path a
				// duplicate dispatch takes: the completed-message yield lands in the
				// callback AFTER a grace finalize already ended the call's turn, and
				// per-message dedup cannot see across turns. Not recorded either — a
				// forwarded call must not be claimable again.
				debug(`processAssistantMessage fallback: tool_use ${block.id} already ${queryContext.forwardedToolCallIds.has(block.id) ? "forwarded" : "dead"} — skipping duplicate`);
				continue;
			}
			ensureTurnStarted(queryContext);
			queryContext.turnSawToolCall = true;
			const mappedName = mapToolName(block.name, customToolNameToPi);
			const mappedArgs = mapToolArgs(mappedName, block.input);
			queryContext.recordToolCall(block.id, mappedName, mappedArgs);
			// A same-message re-yield of an already-mirrored call refreshes its
			// arguments in place — a second toolCall block would make pi dispatch
			// the tool twice.
			const existingIndex = queryContext.turnBlocks.findIndex((b: any) => b.type === "toolCall" && b.id === block.id);
			if (existingIndex >= 0) {
				const existing = queryContext.turnBlocks[existingIndex] as any;
				existing.name = mappedName;
				existing.arguments = mappedArgs;
				queryContext.updateToolCallArgs(block.id, mappedArgs);
				continue;
			}
			queryContext.turnBlocks.push({
				type: "toolCall", id: block.id,
				name: mappedName,
				arguments: mappedArgs,
			});
			const idx = queryContext.turnBlocks.length - 1;
			const toolBlock = queryContext.turnBlocks[idx];
			queryContext.currentPiStream?.push({ type: "toolcall_start", contentIndex: idx, partial: queryContext.output });
			queryContext.currentPiStream?.push({ type: "toolcall_end", contentIndex: idx, toolCall: toolBlock as any, partial: queryContext.output });
		} else if (block.type === "fallback") {
			updateTurnOutputModel(block.to?.model, queryContext);
		} else {
			debug("processAssistantMessage: unhandled block type", block.type);
		}
	}
	if (assistantMessage.usage && queryContext.turnOutput) updateUsage(queryContext.turnOutput, assistantMessage.usage, model, queryContext);

	// End the stream on tool_use. Immediate (no grace deferral) ON PURPOSE: this
	// branch only runs when NO content blocks streamed for the message, so there
	// is no reason to expect terminal stream events either, and the completed
	// message's own usage — applied just above — is the best figure available.
	if (queryContext.turnSawToolCall && queryContext.currentPiStream && queryContext.turnOutput) {
		endToolUseTurn(queryContext);
	}
}
