import { latestCustomData } from "./session-entries.ts";

// A fresh implementation session is seeded with this entry before session_start fires.
export const PLAN_HANDOFF_ENTRY_TYPE = "plan-handoff";

export function isPlanHandoffSession(sessionManager: { getEntries(): readonly unknown[] }): boolean {
  return latestCustomData(sessionManager, PLAN_HANDOFF_ENTRY_TYPE) !== undefined;
}
