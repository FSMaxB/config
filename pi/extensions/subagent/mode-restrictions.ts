/**
 * When the dispatching session is in a restricted mode (plan or explore),
 * subagents must not get tools the main agent itself could not use freely.
 * The mode is not inherited: the child just blocks the restricted tools with
 * an explanation instead of prompting anyone.
 *
 * The allowed set shares the restricted modes' verified local read-only
 * classification and explicit grants, minus denials. Human/orchestration tools stay out of
 * headless children even when granted.
 */

import { planToolPermission, trustedReadOnlyToolNames, type ToolPolicyInfo } from "../lib/tool-permission-policy.ts";

export function restrictedModeAllowedTools(
  snapshot: ModeDecisionsSnapshot,
  persisted: PersistedModeDecisions,
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
  modeAllowed: ReadonlySet<string> | undefined,
): string[] | undefined {
  if (modeAllowed === undefined) return requested;
  const candidates = requested ?? [...modeAllowed];
  return [...new Set(candidates.filter(name => modeAllowed.has(name)))];
}

export interface ModeDecisionsSnapshot {
  sessionGrants: string[];
  sessionDenials: string[];
}

export interface PersistedModeDecisions {
  alwaysAllowed: string[];
  alwaysDenied: string[];
}
