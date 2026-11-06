// After its final agent_end a print-mode child only flushes stdout and runs its session_shutdown handlers.
export const EXIT_GRACE_MILLISECONDS = 10_000;

export type ChildPhase = "working" | "finished";

export function phaseAfterEvent(phase: ChildPhase, event: { type?: unknown; willRetry?: unknown }): ChildPhase {
  switch (event.type) {
    case "agent_end":
    case "compaction_end":
      return event.willRetry === true ? "working" : "finished";
    case "agent_start":
    case "auto_retry_start":
    case "compaction_start":
      return "working";
    default:
      return phase;
  }
}
