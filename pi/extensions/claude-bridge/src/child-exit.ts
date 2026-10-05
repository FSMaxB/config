// Observes the exit of the Claude Code children one bridge query spawns. The SDK
// only exposes the child through the spawnClaudeCodeProcess seam, so a tracker
// wraps that seam per query and the abort path asks it whether every child has
// exited before deciding what to do with the session record.

import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { spawnClaudeCodeWithDiagnostics } from "./claude-executable.js";
import { debug } from "./debug.js";

// How long an aborted query waits for its killed child. The SDK's close() gives
// the child 2 s to exit on its own after closing stdin and SIGTERMs it after
// that, so 3 s covers a voluntary exit and a prompt SIGTERM exit. A child still
// alive after that is treated as a possible writer to its session JSONL.
export const ABORT_EXIT_GRACE_MS = 3000;

export type ChildExitOutcome = "exited" | "still-running";

export interface ChildExitTracker {
	/** Drop-in for the SDK's spawnClaudeCodeProcess option. */
	spawn: (options: SpawnOptions) => SpawnedProcess;
	/** Resolves "exited" once every child spawned through this tracker has
	 *  exited (at once when none was spawned), or "still-running" after graceMs. */
	awaitExit(graceMs: number): Promise<ChildExitOutcome>;
}

// ESM live bindings: importers read the CURRENT values at call time.
export let spawnClaudeCodeProcessImpl: (options: SpawnOptions) => SpawnedProcess = spawnClaudeCodeWithDiagnostics;
export let abortExitGraceMs = ABORT_EXIT_GRACE_MS;

/** Test seam: replaces the real spawn with a fake SpawnedProcess factory. */
export function __testSetSpawnClaudeCodeProcess(impl?: (options: SpawnOptions) => SpawnedProcess): void {
	spawnClaudeCodeProcessImpl = impl ?? spawnClaudeCodeWithDiagnostics;
}

/** Test seam: shortens the abort grace so a "still-running" child is cheap to test. */
export function __testSetAbortExitGraceMs(ms?: number): void {
	abortExitGraceMs = ms ?? ABORT_EXIT_GRACE_MS;
}

export function createChildExitTracker(): ChildExitTracker {
	const exits: Array<Promise<void>> = [];
	return {
		spawn(options) {
			const child = spawnClaudeCodeProcessImpl(options);
			exits.push(new Promise<void>((resolve) => {
				child.once("exit", () => resolve());
				// A spawn failure never produces an exit event; there is no process to wait for.
				child.on("error", () => resolve());
			}));
			return child;
		},
		async awaitExit(graceMs) {
			if (exits.length === 0) return "exited";
			let timer: ReturnType<typeof setTimeout> | undefined;
			const grace = new Promise<ChildExitOutcome>((resolve) => {
				timer = setTimeout(() => resolve("still-running"), graceMs);
			});
			const allExited = Promise.all(exits).then((): ChildExitOutcome => "exited");
			const outcome = await Promise.race([allExited, grace]);
			clearTimeout(timer);
			debug(`child exit tracker: ${exits.length} child(ren), outcome=${outcome} within ${graceMs}ms`);
			return outcome;
		},
	};
}
