/**
 * When the dispatching session is in plan mode, subagents must not get
 * tools the main agent itself could not use freely. Plan mode is not
 * inherited: the child just blocks the restricted tools with an
 * explanation instead of prompting anyone.
 *
 * The allowed set mirrors plan-mode.ts: the path-gated read tools plus
 * whatever the user granted, minus explicit denials. The interactive-only
 * entries of plan-mode's ungated set (question and the plan tools) are
 * useless in a headless child and stay out.
 *
 * The only import is a dependency-free constants module, so this module
 * stays runnable in isolation for testing.
 */

import { READ_FILE_TOOLS } from "../lib/file-tools.ts";

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
  const allowed = new Set([...READ_FILE_TOOLS, ...snapshot.sessionGrants, ...persisted.alwaysAllowed]);
  for (const name of [...snapshot.sessionDenials, ...persisted.alwaysDenied]) {
    allowed.delete(name);
  }
  return allowed;
}
