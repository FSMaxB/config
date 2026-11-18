import { calculateCost } from "@earendil-works/pi-ai";
import type { AssistantMessage, AssistantMessageEventStream, JsonObject, Model, Api } from "@earendil-works/pi-ai";
import type { SDKAssistantMessage, SDKPartialAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import { appendIntegrityEntry, safeNotify } from "./bridge-state.js";
import { debug, diagDump } from "./debug.js";
import { currentQueryContext, failStrandedToolCall } from "./query-state.js";
import type { ClaudeTranscriptAnchor, QueryContext, StreamingToolCall, TurnBlock } from "./query-state.js";
import { jsonObjectFrom, parseJsonObject } from "./json-value.js";
import { isPiDispatchable, mapToolArguments, mapToolName } from "./tool-mapping.js";
import { parseAssistantMessage, parseStreamEvent } from "./stream-events.js";
import type { BlockDelta, CompletedAssistantMessage, ReportedUsage, StartedBlock } from "./stream-events.js";
import { PERCENT } from "../../lib/units.ts";


function updateUsage(output: AssistantMessage, usage: ReportedUsage, model: Model<Api>, queryContext: QueryContext): void {
	// Anthropic reports per-message counters and RE-reports them as the message
	// grows, so the in-flight message's figures replace, never accumulate. What
	// accumulates is every child message already finished in this Pi turn — see
	// `turnUsageCarry` in query-state.ts for why a turn can span several. A
	// message already billed by an earlier Pi turn contributes only its increase
	// (`billedMessageUsage` in query-state.ts).
	const current = queryContext.currentMessageUsage;
	const carry = queryContext.turnUsageCarry;
	if (usage.input !== undefined) current.input = usage.input;
	if (usage.output !== undefined) current.output = usage.output;
	if (usage.cacheRead !== undefined) current.cacheRead = usage.cacheRead;
	if (usage.cacheWrite !== undefined) current.cacheWrite = usage.cacheWrite;
	const unbilled = queryContext.unbilledCurrentMessageUsage();
	output.usage.input = carry.input + unbilled.input;
	output.usage.output = carry.output + unbilled.output;
	output.usage.cacheRead = carry.cacheRead + unbilled.cacheRead;
	output.usage.cacheWrite = carry.cacheWrite + unbilled.cacheWrite;
	output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
	calculateCost(model, output.usage);
	const promptTokens = output.usage.input + output.usage.cacheRead + output.usage.cacheWrite;
	const cachePct = promptTokens > 0 ? Math.round(output.usage.cacheRead / promptTokens * PERCENT) : 0;
	debug(`usage: in=${output.usage.input} out=${output.usage.output} cacheRead=${output.usage.cacheRead} cacheWrite=${output.usage.cacheWrite} total=${output.usage.totalTokens} cachePct=${cachePct}% model=${model.id}`);
}


function mapStopReason(reason: string | undefined): "stop" | "length" | "toolUse" {
	if (reason === "tool_use") return "toolUse";
	if (reason === "max_tokens") return "length";
	return "stop";
}

export function parsePartialJson(input: string, fallback: JsonObject): JsonObject {
	if (!input) return fallback;
	return parseJsonObject(input) ?? fallback;
}

function isToolCallWithId(block: TurnBlock, id: string): block is StreamingToolCall {
	return block.type === "toolCall" && block.id === id;
}

// A streamed tool call whose arguments are still a partial parse; it must never execute.
function isPartialToolCall(block: TurnBlock): block is StreamingToolCall {
	return block.type === "toolCall" && block.partialJson !== undefined;
}

// Both take the query context explicitly (defaulting to the live one) so the
// completion/teardown closures in index.ts can finalize the stream of the query
// they were created for — under reentrancy the live currentQueryContext() is the subagent's.
export function ensureTurnStarted(queryContext: QueryContext = currentQueryContext()): void {
	if (queryContext.turnStarted || !queryContext.currentPiStream || !queryContext.turnOutput) return;
	queryContext.currentPiStream.push({ type: "start", partial: queryContext.output });
	queryContext.turnStarted = true;
}

export function finalizeCurrentStream(stopReason?: string, queryContext: QueryContext = currentQueryContext(), anchor?: ClaudeTranscriptAnchor): void {
	if (!queryContext.currentPiStream || !queryContext.turnOutput) return;
	debug(`provider: finalizeCurrentStream called, stopReason=${stopReason}, turnOutput=${JSON.stringify({stopReason: queryContext.turnOutput.stopReason, error: queryContext.turnOutput.errorMessage})}`);
	if (!queryContext.turnStarted) ensureTurnStarted(queryContext);
	const reason = stopReason === "length" ? "length" : "stop";
	if (anchor) Object.assign(queryContext.turnOutput, { claudeBridge: anchor });
	queryContext.markCurrentMessageBilled();
	queryContext.currentPiStream.push({ type: "done", reason, message: queryContext.turnOutput });
	queryContext.currentPiStream.end();
	queryContext.currentPiStream = undefined;
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
	const partial = queryContext.turnBlocks.filter(isPartialToolCall);
	if (partial.length > 0) {
		const calls = partial.map((block) => ({ id: block.id, name: block.name }));
		debug(`endToolUseTurn: pruning ${partial.length} still-partial tool call(s) — truncated arguments never execute:`, calls.map((entry) => `${entry.name} [${entry.id}]`).join(", "));
		diagDump("partial_tool_calls_pruned", { count: partial.length, calls });
		appendIntegrityEntry("partial_tool_calls_pruned", { count: partial.length, calls });
		queryContext.turnOutput.content = queryContext.turnBlocks.filter((block) => !isPartialToolCall(block));
	}
	// Every tool call Pi is about to execute from this turn is owed a result and
	// must never be dispatched again: a lagging stream replays the same tool_use
	// into the NEXT turn, whose per-message dedup cannot see it.
	for (const block of queryContext.turnOutput.content) {
		if (block.type === "toolCall") queryContext.forwardedToolCallIds.add(block.id);
	}
	queryContext.turnOutput.stopReason = "toolUse";
	queryContext.markCurrentMessageBilled();
	queryContext.currentPiStream.push({ type: "done", reason: "toolUse", message: queryContext.turnOutput });
	queryContext.currentPiStream.end();
	queryContext.currentPiStream = undefined;
}

export function cancelScheduledToolUseEnd(queryContext: QueryContext): void {
	if (!queryContext.scheduledToolUseEnd) return;
	clearTimeout(queryContext.scheduledToolUseEnd.timer);
	queryContext.scheduledToolUseEnd = undefined;
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
// A parked-results notice names the first few tools; the rest only lengthen the message.
const MAX_LISTED_TOOL_NAMES = 6;

export function reapStaleQueuedResults(queryContext: QueryContext): void {
	const stale = queryContext.takeStaleQueuedResults();
	if (stale.length === 0) return;
	const names = stale.map((entry) => entry.toolName);
	debug(`reapStaleQueuedResults: parked ${stale.length} early tool result(s) awaiting a late handler:`, names.join(", "));
	diagDump("stale_queued_tool_results_parked", { count: stale.length, stale });
	appendIntegrityEntry("stale_queued_tool_results_parked", { count: stale.length, stale });
	safeNotify(
		`queued-results-parked=${JSON.stringify({ count: stale.length, tools: names })}\n` +
		`Claude bridge: parked ${stale.length} early tool result(s) whose handler has not arrived (${names.slice(0, MAX_LISTED_TOOL_NAMES).join(", ")}${names.length > MAX_LISTED_TOOL_NAMES ? ", …" : ""}). ` +
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
	mappedArguments: JsonObject,
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
	let index = queryContext.turnBlocks.findIndex((block) => isToolCallWithId(block, toolCallId));
	const existing = index === -1 ? undefined : queryContext.turnBlocks[index];
	if (existing?.type === "toolCall") {
		const block = existing;
		if (block.partialJson !== undefined) {
			// Stream ended before content_block_stop. The SDK invoked this handler
			// with the COMPLETE schema-validated input, so the handler's copy is
			// authoritative — the streamed partial JSON is by definition behind it.
			// Settling from the partial forwards `{}`-argument calls that Pi then
			// executes and errors on, a divergence the synthesize branch below
			// cannot have.
			block.arguments = mappedArguments;
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
		const block: StreamingToolCall = { type: "toolCall", id: toolCallId, name: toolName, arguments: mappedArguments };
		queryContext.turnBlocks.push(block);
		index = queryContext.turnBlocks.length - 1;
		queryContext.currentPiStream.push({ type: "toolcall_start", contentIndex: index, partial: queryContext.output });
		queryContext.currentPiStream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: queryContext.output });
	}
	// Settle every OTHER still-partial block whose handler has fired: each
	// waiting handler carries the authoritative args for its own call.
	for (let blockIndex = 0; blockIndex < queryContext.turnBlocks.length; blockIndex++) {
		const sibling = queryContext.turnBlocks[blockIndex];
		if (!isPartialToolCall(sibling)) continue;
		const waiting = queryContext.pendingToolCalls.get(sibling.id);
		if (!waiting) continue;
		sibling.arguments = waiting.args;
		queryContext.updateToolCallArgs(sibling.id, sibling.arguments);
		delete sibling.partialJson;
		delete sibling.index;
		queryContext.currentPiStream.push({ type: "toolcall_end", contentIndex: blockIndex, toolCall: sibling, partial: queryContext.output });
	}
	// A block still partial here has NO fired handler: its complete arguments
	// exist nowhere on this side of the boundary yet. Ending the turn now would
	// hand Pi truncated arguments to execute — a truncated bash command is not a
	// hypothetical hazard — so give the lagging stream more grace first.
	const unsettled = queryContext.turnBlocks.filter(isPartialToolCall);
	if (unsettled.length > 0 && rearmCount < FINALIZE_MAX_REARMS) {
		debug(`mcp handler: ${unsettled.length} sibling tool call(s) still streaming — re-arming grace (${rearmCount + 1}/${FINALIZE_MAX_REARMS})`);
		scheduleToolUseTurnEnd(
			queryContext,
			() => finalizeToolUseTurnFromMcpInvocation(queryContext, toolCallId, toolName, mappedArguments, rearmCount + 1),
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
	const executable = queryContext.turnBlocks.some((block) => block.type === "toolCall" && !isPartialToolCall(block));
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
	message: SDKPartialAssistantMessage,
	customToolNameToPi: ReadonlyMap<string, string>,
	model: Model<Api>,
	// The consuming query's CAPTURED context, never the live currentQueryContext() (see the
	// note in consumeQuery): a reentrant subagent can be pushed while the parent
	// iterator is suspended, and live-state reads would hit the wrong query.
	queryContext: QueryContext = currentQueryContext(),
): void {
	if (!queryContext.currentPiStream || !queryContext.turnOutput) return;
	const event = parseStreamEvent(message.event);
	// Claude Code forwards the API's keep-alive pings too, which the SDK's event type leaves out.
	if (event.type === "ping") return;
	// Any event proves the stream is alive, matched or not (the completed-message
	// yield strips block indexes, so later content_block_stop events show up as
	// unmatched): the grace timer exists for streams that go silent, not for slow
	// ones. Pings are excluded so a keep-alive can never hold a dead turn open.
	postponeToolUseTurnEnd(queryContext);
	if (event.type === "message_stop" && !queryContext.turnSawToolCall) {
		debug("processStreamEvent: ignoring bare message_stop with no streamed content/tool call");
		return;
	}

	switch (event.type) {
		case "message_start":
			// The child moving on to another message is where a still-queued result
			// would start poisoning mismatch reports: park it, consumable by a late
			// handler (see reapStaleQueuedResults).
			reapStaleQueuedResults(queryContext);
			queryContext.resetToolTracking();
			// Another child message begins: bank what the previous one billed before
			// its counters are replaced. No-op on the turn's first, and no-op if this
			// same message was already declared (see beginChildMessage).
			queryContext.beginChildMessage(event.messageId);
			updateTurnOutputModel(event.model, queryContext);
			if (event.usage !== undefined) updateUsage(queryContext.turnOutput, event.usage, model, queryContext);
			return;
		case "content_block_start":
			processContentBlockStart(event.index, event.block, customToolNameToPi, queryContext, queryContext.currentPiStream);
			return;
		case "content_block_delta":
			processContentBlockDelta(event.index, event.delta, queryContext, queryContext.currentPiStream);
			return;
		case "content_block_stop":
			processContentBlockStop(event.index, queryContext, queryContext.currentPiStream);
			return;
		case "message_delta":
			queryContext.turnOutput.stopReason = mapStopReason(event.stopReason);
			if (event.usage !== undefined) updateUsage(queryContext.turnOutput, event.usage, model, queryContext);
			return;
		case "message_stop":
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
		case "unknown":
			debug("processStreamEvent: unhandled event type", event.eventType);
			return;
	}
}

function processContentBlockStart(
	index: number,
	contentBlock: StartedBlock,
	customToolNameToPi: ReadonlyMap<string, string>,
	queryContext: QueryContext,
	stream: AssistantMessageEventStream,
): void {
	queryContext.turnSawStreamEvent = true;
	ensureTurnStarted(queryContext);
	// This block owns its index from here on, so release any child-executed
	// or suppressed claim on it. Belt-and-braces against a missed
	// message_start: without this a stale index could silently swallow a later
	// text block's deltas.
	queryContext.suppressedStreamIndexes.delete(index);
	if (contentBlock.type === "tool_use" && !isPiDispatchable(contentBlock.name, customToolNameToPi)) {
		queryContext.suppressedStreamIndexes.add(index);
		queryContext.noteUnexpectedChildCall(contentBlock.id, contentBlock.name);
		debug(`processStreamEvent: non-dispatchable tool ${contentBlock.name} [${contentBlock.id}] — not mirrored as a Pi tool call`);
		return;
	}
	switch (contentBlock.type) {
		case "text":
			queryContext.turnBlocks.push({ type: "text", text: "", index });
			stream.push({ type: "text_start", contentIndex: queryContext.turnBlocks.length - 1, partial: queryContext.output });
			return;
		case "thinking":
			queryContext.turnBlocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index });
			stream.push({ type: "thinking_start", contentIndex: queryContext.turnBlocks.length - 1, partial: queryContext.output });
			return;
		case "tool_use": {
			const streamedId = contentBlock.id;
			if (queryContext.forwardedToolCallIds.has(streamedId) || queryContext.deadToolCallIds.has(streamedId)) {
				// A lagging stream replaying a call Pi already executed — or one whose
				// handler was already failed as stranded — into a later turn. Mirroring
				// it would make Pi dispatch it a second time.
				queryContext.suppressedStreamIndexes.add(index);
				debug(`processStreamEvent: tool_use ${streamedId} already ${queryContext.forwardedToolCallIds.has(streamedId) ? "forwarded" : "dead"} — suppressing duplicate stream block`);
				return;
			}
			if (queryContext.turnBlocks.some((block) => isToolCallWithId(block, streamedId))) {
				// Same turn, same id: the completed-message yield beat the stream (its
				// block is already recorded with complete arguments). A second
				// partialJson copy would ship the id twice in one done message — and
				// if its stop never arrives, ship it truncated.
				queryContext.suppressedStreamIndexes.add(index);
				debug(`processStreamEvent: tool_use ${streamedId} already recorded in this turn — suppressing duplicate stream block`);
				return;
			}
			queryContext.turnSawToolCall = true;
			const mappedName = mapToolName(contentBlock.name, customToolNameToPi);
			queryContext.recordToolCall(contentBlock.id, mappedName, {});
			queryContext.turnBlocks.push({
				type: "toolCall", id: contentBlock.id,
				name: mappedName,
				arguments: jsonObjectFrom(contentBlock.input),
				partialJson: "", index,
			});
			stream.push({ type: "toolcall_start", contentIndex: queryContext.turnBlocks.length - 1, partial: queryContext.output });
			return;
		}
		case "unknown":
			debug("processStreamEvent: unhandled content_block_start type", contentBlock.blockType);
			return;
	}
}

function processContentBlockDelta(index: number, delta: BlockDelta, queryContext: QueryContext, stream: AssistantMessageEventStream): void {
	// Suppressed calls have no Pi block; their deltas are not unmatched.
	if (queryContext.suppressedStreamIndexes.has(index)) {
		queryContext.turnSawStreamEvent = true;
		return;
	}
	const blockIndex = queryContext.turnBlocks.findIndex((block) => block.index === index);
	if (blockIndex === -1) {
		debug("processStreamEvent: ignoring unmatched content_block_delta", index);
		return;
	}
	const block = queryContext.turnBlocks[blockIndex];
	queryContext.turnSawStreamEvent = true;
	switch (delta.type) {
		case "text_delta":
			if (block.type !== "text") break;
			block.text += delta.text;
			stream.push({ type: "text_delta", contentIndex: blockIndex, delta: delta.text, partial: queryContext.output });
			return;
		case "thinking_delta":
			if (block.type !== "thinking") break;
			block.thinking += delta.thinking;
			stream.push({ type: "thinking_delta", contentIndex: blockIndex, delta: delta.thinking, partial: queryContext.output });
			return;
		case "input_json_delta":
			if (block.type !== "toolCall") break;
			block.partialJson = (block.partialJson ?? "") + delta.partialJson;
			block.arguments = parsePartialJson(block.partialJson, block.arguments);
			stream.push({ type: "toolcall_delta", contentIndex: blockIndex, delta: delta.partialJson, partial: queryContext.output });
			return;
		case "signature_delta":
			if (block.type !== "thinking") break;
			block.thinkingSignature = (block.thinkingSignature ?? "") + delta.signature;
			return;
		case "unknown":
			break;
	}
	debug("processStreamEvent: unhandled content_block_delta type", delta.type === "unknown" ? delta.deltaType : delta.type);
}

function processContentBlockStop(index: number, queryContext: QueryContext, stream: AssistantMessageEventStream): void {
	// Same as the delta case: the block was never mirrored, so there is nothing
	// to seal and nothing unmatched about it.
	if (queryContext.suppressedStreamIndexes.has(index)) {
		queryContext.turnSawStreamEvent = true;
		return;
	}
	const blockIndex = queryContext.turnBlocks.findIndex((block) => block.index === index);
	if (blockIndex === -1) {
		debug("processStreamEvent: ignoring unmatched content_block_stop", index);
		return;
	}
	const block = queryContext.turnBlocks[blockIndex];
	queryContext.turnSawStreamEvent = true;
	delete block.index;
	switch (block.type) {
		case "text":
			stream.push({ type: "text_end", contentIndex: blockIndex, content: block.text, partial: queryContext.output });
			return;
		case "thinking":
			stream.push({ type: "thinking_end", contentIndex: blockIndex, content: block.thinking, partial: queryContext.output });
			return;
		case "toolCall":
			queryContext.turnSawToolCall = true;
			block.arguments = mapToolArguments(
				block.name, parsePartialJson(block.partialJson ?? "", block.arguments),
			);
			queryContext.updateToolCallArgs(block.id, block.arguments);
			delete block.partialJson;
			stream.push({ type: "toolcall_end", contentIndex: blockIndex, toolCall: block, partial: queryContext.output });
			return;
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
		queryContext.scheduledToolUseEnd = undefined;
		action();
	}, TOOL_USE_END_GRACE_MS);
	timer.unref();
	return { stream, timer, action, source };
}

// The SDK always yields `assistant` messages (completed content blocks) after streaming.
// When stream_events already delivered the content, this is a no-op. But after
// resetTurnState (e.g. tool result delivery), if the next turn's assistant message
// arrives before any stream_events, this is the primary content path. Must maintain
// the same stream lifecycle as processStreamEvent — including ending the stream on
// tool_use to prevent deadlock with the MCP handler.
function appendMissingToolUsesFromAssistant(
	assistantMessage: CompletedAssistantMessage,
	model: Model<Api>,
	customToolNameToPi: ReadonlyMap<string, string>,
	queryContext: QueryContext,
): boolean {
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
		const existingIndex = queryContext.turnBlocks.findIndex((existing) => isToolCallWithId(existing, block.id));
		if (existingIndex < 0 && (queryContext.forwardedToolCallIds.has(block.id) || queryContext.deadToolCallIds.has(block.id))) {
			// Completed-message replay of a call Pi already executed in a turn that
			// has ended (or one already failed as stranded). Not a live Pi turn
			// boundary: sawToolUse stays false for it, and no block is emitted.
			debug(`assistant message: tool_use ${block.id} already ${queryContext.forwardedToolCallIds.has(block.id) ? "forwarded" : "dead"} — skipping duplicate`);
			continue;
		}
		sawToolUse = true;
		const name = mapToolName(block.name, customToolNameToPi);
		const mappedArguments = mapToolArguments(name, block.input);
		queryContext.recordToolCall(block.id, name, mappedArguments);
		if (!streamLive) continue;
		const existing = existingIndex === -1 ? undefined : queryContext.turnBlocks[existingIndex];
		if (existing?.type === "toolCall") {
			existing.name = name;
			existing.arguments = mappedArguments;
			queryContext.updateToolCallArgs(block.id, mappedArguments);
			if (existing.partialJson !== undefined) {
				delete existing.partialJson;
				delete existing.index;
				queryContext.currentPiStream?.push({ type: "toolcall_end", contentIndex: existingIndex, toolCall: existing, partial: queryContext.output });
			}
			continue;
		}

		ensureTurnStarted(queryContext);
		const toolBlock: StreamingToolCall = { type: "toolCall", id: block.id, name, arguments: mappedArguments };
		queryContext.turnBlocks.push(toolBlock);
		const index = queryContext.turnBlocks.length - 1;
		queryContext.currentPiStream?.push({ type: "toolcall_start", contentIndex: index, partial: queryContext.output });
		queryContext.currentPiStream?.push({ type: "toolcall_end", contentIndex: index, toolCall: toolBlock, partial: queryContext.output });
	}
	// Only while the stream is still live: the SDK's assistant yields carry the
	// message_start placeholder usage, and once the done event has delivered
	// turnOutput to pi, overwriting its usage with those placeholders would
	// corrupt the very figure message_delta got right.
	if (assistantMessage.usage !== undefined && queryContext.turnOutput && queryContext.currentPiStream) updateUsage(queryContext.turnOutput, assistantMessage.usage, model, queryContext);
	return sawToolUse;
}

export function processAssistantMessage(message: SDKAssistantMessage, model: Model<Api>, customToolNameToPi: ReadonlyMap<string, string>, queryContext: QueryContext = currentQueryContext()): void {
	const assistantMessage = parseAssistantMessage(message.message);
	if (assistantMessage === undefined) return;
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
	const sameMessage = assistantMessage.id !== undefined && assistantMessage.id.length > 0 && assistantMessage.id === queryContext.currentMessageId;
	if (!sameMessage) {
		reapStaleQueuedResults(queryContext);
		queryContext.resetToolTracking();
	}
	// The no-stream-events path also sees a message boundary. It is keyed on the
	// message ID rather than trusted blindly, because this branch is ALSO reached
	// for a message whose `message_start` already streamed — any message that
	// produced no content blocks, since `turnSawStreamEvent` only tracks those.
	queryContext.beginChildMessage(assistantMessage.id);
	debug(`processAssistantMessage fallback: ${assistantMessage.content.length} blocks, types=${assistantMessage.content.map((block) => block.type).join(",")}${sameMessage ? " (same message re-yield)" : ""}`);
	// Deduped against the WHOLE current turn, not just same-id re-yields: a
	// rejected turn's synthesized error message ("You've hit your weekly limit")
	// arrives as multiple assistant yields whose ids DIFFER or are absent (one
	// pi message, two byte-identical text blocks), so an id-keyed guard alone
	// still renders it twice. A model legitimately
	// producing two byte-identical full blocks in one turn is vanishingly rare;
	// rendering such a duplicate once is the better failure mode.
	const alreadyRendered = (type: "text" | "thinking", content: string): boolean =>
		queryContext.turnBlocks.some((block) =>
			(type === "text" && block.type === "text" && block.text === content)
			|| (type === "thinking" && block.type === "thinking" && block.thinking === content));
	for (const block of assistantMessage.content) {
		switch (block.type) {
			case "text": {
				if (!block.text) continue;
				if (alreadyRendered("text", block.text)) continue;
				ensureTurnStarted(queryContext);
				queryContext.turnBlocks.push({ type: "text", text: block.text });
				const index = queryContext.turnBlocks.length - 1;
				queryContext.currentPiStream?.push({ type: "text_start", contentIndex: index, partial: queryContext.output });
				queryContext.currentPiStream?.push({ type: "text_delta", contentIndex: index, delta: block.text, partial: queryContext.output });
				queryContext.currentPiStream?.push({ type: "text_end", contentIndex: index, content: block.text, partial: queryContext.output });
				continue;
			}
			case "thinking": {
				if (alreadyRendered("thinking", block.thinking)) continue;
				ensureTurnStarted(queryContext);
				queryContext.turnBlocks.push({ type: "thinking", thinking: block.thinking, thinkingSignature: block.signature });
				const blockIndex = queryContext.turnBlocks.length - 1;
				queryContext.currentPiStream?.push({ type: "thinking_start", contentIndex: blockIndex, partial: queryContext.output });
				if (block.thinking) queryContext.currentPiStream?.push({ type: "thinking_delta", contentIndex: blockIndex, delta: block.thinking, partial: queryContext.output });
				queryContext.currentPiStream?.push({ type: "thinking_end", contentIndex: blockIndex, content: block.thinking, partial: queryContext.output });
				continue;
			}
			case "tool_use": {
				if (!isPiDispatchable(block.name, customToolNameToPi)) {
					queryContext.noteUnexpectedChildCall(block.id, block.name);
					debug(`processAssistantMessage fallback: non-dispatchable tool ${block.name} [${block.id}] — not mirrored as a Pi tool call`);
					continue;
				}
				if (!queryContext.turnBlocks.some((existing) => isToolCallWithId(existing, block.id))
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
				const mappedArguments = mapToolArguments(mappedName, block.input);
				queryContext.recordToolCall(block.id, mappedName, mappedArguments);
				// A same-message re-yield of an already-mirrored call refreshes its
				// arguments in place — a second toolCall block would make pi dispatch
				// the tool twice.
				const existing = queryContext.turnBlocks.find((candidate) => isToolCallWithId(candidate, block.id));
				if (existing?.type === "toolCall") {
					existing.name = mappedName;
					existing.arguments = mappedArguments;
					queryContext.updateToolCallArgs(block.id, mappedArguments);
					continue;
				}
				const toolBlock: StreamingToolCall = { type: "toolCall", id: block.id, name: mappedName, arguments: mappedArguments };
				queryContext.turnBlocks.push(toolBlock);
				const blockIndex = queryContext.turnBlocks.length - 1;
				queryContext.currentPiStream?.push({ type: "toolcall_start", contentIndex: blockIndex, partial: queryContext.output });
				queryContext.currentPiStream?.push({ type: "toolcall_end", contentIndex: blockIndex, toolCall: toolBlock, partial: queryContext.output });
				continue;
			}
			case "fallback":
				updateTurnOutputModel(block.model, queryContext);
				continue;
			case "unknown":
				debug("processAssistantMessage: unhandled block type", block.blockType);
				continue;
		}
	}
	if (assistantMessage.usage !== undefined && queryContext.turnOutput) updateUsage(queryContext.turnOutput, assistantMessage.usage, model, queryContext);

	// End the stream on tool_use. Immediate (no grace deferral) ON PURPOSE: this
	// branch only runs when NO content blocks streamed for the message, so there
	// is no reason to expect terminal stream events either, and the completed
	// message's own usage — applied just above — is the best figure available.
	if (queryContext.turnSawToolCall && queryContext.currentPiStream && queryContext.turnOutput) {
		endToolUseTurn(queryContext);
	}
}
