/**
 * When the dispatching session is in plan mode, subagents must not get
 * tools the main agent itself could not use freely. Plan mode is not
 * inherited: the child just blocks the restricted tools with an
 * explanation instead of prompting anyone.
 *
 * The allowed set shares plan-mode's verified local read-only classification
 * and explicit grants, minus denials. Human/orchestration tools stay out of
 * headless children even when granted.
 */

import { planToolPermission, trustedReadOnlyToolNames, type ToolPolicyInfo } from "../lib/tool-permission-policy.ts";

export function planModeAllowedTools(
  snapshot: PlanModeSnapshot,
  persisted: PersistedPlanDecisions,
  tools: readonly ToolPolicyInfo[],
): Set<string> {
  const trusted = trustedReadOnlyToolNames(tools);
  const decisions = {
    ...snapshot, alwaysGrants: persisted.alwaysAllowed, alwaysDenials: persisted.alwaysDenied,
  };
  return new Set(tools.filter(tool => tool.exposure !== "hidden" && tool.exposure !== "model-only" &&
    planToolPermission(tool.name, decisions, new Set(), trusted) === "allow").map(tool => tool.name));
}

export function effectiveChildTools(
  requested: string[] | undefined,
  planAllowed: ReadonlySet<string> | undefined,
): string[] | undefined {
  if (planAllowed === undefined) return requested;
  const candidates = requested ?? [...planAllowed];
  return [...new Set(candidates.filter(name => planAllowed.has(name)))];
}

export interface PlanModeSnapshot {
  sessionGrants: string[];
  sessionDenials: string[];
}

export interface PersistedPlanDecisions {
  alwaysAllowed: string[];
  alwaysDenied: string[];
}
