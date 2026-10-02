import { latestCustomData } from "./session-entries.ts";

export const PLAN_MODE_ENTRY_TYPE = "plan-mode";

export interface Denial {
  name: string;
  note?: string;
}

export interface PlanModeEntry {
  enabled: boolean;
  sessionGrants: string[];
  sessionDenials: Denial[];
}

// The newest "plan-mode" entry on the current branch holds the live plan-mode state, so
// navigating the session tree selects that branch's mode and decisions. plan-mode.ts reads it
// to restore session state, and the subagent extension reads it to cap child tools without
// importing plan-mode.ts. Adapters without getBranch fall back to all entries.
export function latestPlanModeEntry(
  sessionManager: { getEntries(): readonly unknown[]; getBranch?(): readonly unknown[] },
): PlanModeEntry | undefined {
  const source = typeof sessionManager.getBranch === "function"
    ? { getEntries: () => sessionManager.getBranch!() }
    : sessionManager;
  const data = latestCustomData(source, PLAN_MODE_ENTRY_TYPE);
  if (!data) return undefined;

  const { enabled, sessionGrants, sessionDenials } = data;
  return {
    enabled: enabled === true,
    sessionGrants: stringList(sessionGrants),
    sessionDenials: denialList(sessionDenials),
  };
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

// Denials used to be bare tool names, and sessions recorded before the note existed still are.
export function denialList(value: unknown): Denial[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [{ name: item }];
    if (!item || typeof item !== "object") return [];

    const { name, note } = item as { name?: unknown; note?: unknown };
    if (typeof name !== "string") return [];
    return [typeof note === "string" ? { name, note } : { name }];
  });
}
