/**
 * When the dispatching session is in plan mode, subagents must not get
 * tools the main agent itself could not use freely. Plan mode is not
 * inherited: the child just blocks the restricted tools with an
 * explanation instead of prompting anyone.
 *
 * The allowed set mirrors plan-mode.ts: its ungated read-only tools
 * plus whatever the user granted, minus explicit denials. The
 * interactive-only entries of plan-mode's ungated set (question and
 * the plan tools) are useless in a headless child and stay out.
 *
 * No runtime external imports, so the module stays runnable in
 * isolation for testing.
 */

const PLAN_MODE_READ_TOOLS = ["repo_read", "repo_grep", "repo_find", "repo_ls", "memory_read", "memory_ls"];

export interface PlanModeSnapshot {
  enabled: boolean;
  sessionGrants: string[];
  sessionDenials: string[];
}

export interface PersistedPlanDecisions {
  alwaysAllowed: string[];
  alwaysDenied: string[];
}

export function planModeAllowedTools(snapshot: PlanModeSnapshot, persisted: PersistedPlanDecisions): Set<string> {
  const allowed = new Set([...PLAN_MODE_READ_TOOLS, ...snapshot.sessionGrants, ...persisted.alwaysAllowed]);
  for (const name of [...snapshot.sessionDenials, ...persisted.alwaysDenied]) {
    allowed.delete(name);
  }
  return allowed;
}
