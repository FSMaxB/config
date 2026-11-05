/**
 * When the dispatching session is in a restricted mode (plan or explore),
 * subagents must not get tools the main agent itself could not use freely.
 * The mode is not inherited: the child just blocks the restricted tools with
 * an explanation instead of prompting anyone.
 *
 * The allowed set shares the restricted modes' verified local read-only
 * classification and explicit grants, minus denials. Human/orchestration tools stay out of
 * headless children even when granted. As in the main session, bash is admitted
 * while the sandbox is active, since the sandbox keeps the repository read-only.
 */

import { planToolPermission, trustedReadOnlyToolNames, type ToolPolicyInfo } from "../lib/tool-permission-policy.ts";

export function restrictedModeAllowedTools(
  snapshot: ModeDecisionsSnapshot,
  persisted: PersistedModeDecisions,
  tools: readonly ToolPolicyInfo[],
  sandboxActive: boolean,
): Set<string> {
  const trusted = trustedReadOnlyToolNames(tools);
  // Denials still win: planToolPermission checks them before the trusted set.
  if (sandboxActive) trusted.add("bash");
  const decisions = {
    ...snapshot, alwaysGrants: persisted.alwaysAllowed, alwaysDenials: persisted.alwaysDenied,
  };
  return new Set(tools.filter(tool => tool.exposure !== "hidden" && tool.exposure !== "model-only" &&
    planToolPermission(tool.name, decisions, new Set(), trusted) === "allow").map(tool => tool.name));
}

export const ChildToolVerdict = { Allowed: "allowed", Restricted: "restricted", NoSandbox: "no-sandbox" } as const;
export type ChildToolVerdict = (typeof ChildToolVerdict)[keyof typeof ChildToolVerdict];

// The parent only admits bash when its own sandbox is active; the child checks its own, since a sandbox
// extension that failed to load leaves stock bash behind.
export function childToolVerdict(toolName: string, allowedTools: ReadonlySet<string>, sandboxActive: boolean): ChildToolVerdict {
  if (!allowedTools.has(toolName)) return ChildToolVerdict.Restricted;
  return toolName === "bash" && !sandboxActive ? ChildToolVerdict.NoSandbox : ChildToolVerdict.Allowed;
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
