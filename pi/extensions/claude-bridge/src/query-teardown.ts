// End-of-query teardown, extracted from streamClaudeAgentSdk's .finally so it
// operates on the ONE context captured at query start — never the live ctx().
// The two only differ while a reentrant (subagent) context is pushed, which is
// exactly when a parent query ending abnormally (abort, child process death)
// teardown must run against the parent state. Using the subagent state skips
// the parent's drain and activeQuery clear, which leaks handlers.

import { reportToolResultMismatch } from "./bridge-state.js";
import { type ChildExitOutcome } from "./child-exit.js";
import { debug } from "./debug.js";
import { drainPendingToolCalls, popContextFor, type QueryContext, type ToolCallDrainCause } from "./query-state.js";

/** Close a settled or dying SDK query. Its transport can throw on the way down
 *  — a child already gone, a socket already closed — and that throw belongs to
 *  the query being closed, never to whatever its caller does next. */
export function closeSdkQuery(sdkQuery: unknown): void {
	try { (sdkQuery as { close(): void }).close(); }
	catch (error) { debug("provider: closing the sdk query threw; continuing teardown:", error); }
}

/** Stop an in-flight SDK query. `interrupt()` asks the CLI to stop gracefully,
 *  `close()` kills it; both are needed, because interrupt alone lets the current
 *  API call finish. */
export function abortSdkQuery(sdkQuery: unknown): void {
	void (sdkQuery as { interrupt(): Promise<void> }).interrupt().catch(() => {});
	closeSdkQuery(sdkQuery);
}

/** Tear down `queryCtx` after its SDK query settled. No-ops when the query is
 *  is not the context's active one (a continuation replaced it, or teardown
 *  already ran). Returns true when teardown actually ran. */
export function teardownQuery(
	queryCtx: QueryContext,
	sdkQuery: unknown,
	cause: ToolCallDrainCause,
	cwd: string,
	isReentrant: boolean,
): boolean {
	if (queryCtx.activeQuery !== sdkQuery) return false;
	reportToolResultMismatch(queryCtx, "query teardown", cwd, { forceRotate: cause !== "query-end" });
	// Drain pending handlers for this query as errors naming the cause —
	// their results are never coming.
	const drained = drainPendingToolCalls(queryCtx, cause);
	if (drained > 0) debug(`provider: query teardown drained ${drained} waiting MCP handler(s) as errors (cause=${cause})`);
	queryCtx.pendingResults.clear();

	if (isReentrant) {
		// Merges deferred messages and restores/repairs the stack. popContextFor
		// (not popContext): a live subagent context may sit above this one.
		if (!popContextFor(queryCtx)) debug("provider: query teardown found context already popped; skipping pop");
	} else {
		queryCtx.activeQuery = null;
	}
	return true;
}

export interface AbortSettlement {
	childExit: ChildExitOutcome;
	/** A tool call was waiting, queued or unmatched when the abort hit. */
	toolCallInFlight: boolean;
	droppedQueuedUserMessages: number;
	/** The query or the record knows which Claude session this turn ran in. */
	hasSessionId: boolean;
}

/** Why an aborted query's record must rebuild, or undefined when the
 *  interruption was clean enough to resume the same Claude session next turn.
 *  The unconfirmed exit is checked first because it is the only reason that
 *  also rotates the session id. */
export function abortRebuildReason(settlement: AbortSettlement): string | undefined {
	if (settlement.childExit === "still-running") return "abort while the Claude Code process was still running";
	if (settlement.toolCallInFlight) return "abort with a tool call in flight";
	if (settlement.droppedQueuedUserMessages > 0) return `abort dropped ${settlement.droppedQueuedUserMessages} queued user message(s)`;
	if (!settlement.hasSessionId) return "abort before Claude Code reported a session";
	return undefined;
}
