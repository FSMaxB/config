import { AgentMode, isRestricted, MODE_IDENTITIES, type RestrictedMode } from "./agent-mode.ts";
import type { ToolPermission } from "./tool-permission-policy.ts";

// The decisions restricted-mode.ts makes, kept free of pi imports so they run under plain node
// tests; the engine itself only wires them to the session, the UI and the stores.

export const StateRecording = { Keep: "keep", Record: "record" } as const;
export type StateRecording = (typeof StateRecording)[keyof typeof StateRecording];

// requested holds the modes whose startup flag applies to this session. Planning wins over
// exploring when both are requested. Subagents read the recorded state, so a mode the branch
// does not record yet is recorded.
export function startupMode(
  restored: { mode: AgentMode; recorded: boolean },
  requested: readonly RestrictedMode[],
): { mode: AgentMode; recording: StateRecording } {
  const mode = requested.includes(AgentMode.Planning)
    ? AgentMode.Planning
    : requested.includes(AgentMode.Exploring)
      ? AgentMode.Exploring
      : restored.mode;
  const recording = restored.recorded && mode === restored.mode ? StateRecording.Keep : StateRecording.Record;
  return { mode, recording };
}

export const Timing = { Immediate: "immediate", Deferred: "deferred" } as const;
export type Timing = (typeof Timing)[keyof typeof Timing];

// Switching modes while the agent runs is deferred to the next tool call, so the notice says when.
export function transitionNotice(from: AgentMode, to: AgentMode, timing: Timing): string {
  const deferred = timing === Timing.Deferred;
  const fromLabel = isRestricted(from) ? MODE_IDENTITIES[from].label : undefined;
  const toLabel = isRestricted(to) ? MODE_IDENTITIES[to].label : undefined;
  if (fromLabel && toLabel) {
    return deferred
      ? `Switching from ${fromLabel.toLowerCase()} to ${toLabel.toLowerCase()} at the next tool call.`
      : `${fromLabel} disabled, ${toLabel.toLowerCase()} enabled.`;
  }
  if (toLabel) return `${toLabel} ${deferred ? "will be enabled at the next tool call" : "enabled"}.`;
  if (fromLabel) return `${fromLabel} ${deferred ? "will be disabled at the next tool call" : "disabled"}.`;
  return "";
}

export const Interaction = { Available: "available", Unavailable: "unavailable" } as const;
export type Interaction = (typeof Interaction)[keyof typeof Interaction];
export type ToolGate = { kind: "run" } | { kind: "block"; reason: string } | { kind: "ask" };

export function toolGate(
  toolName: string,
  { mode, denials, permission, interaction }: {
    mode: AgentMode;
    denials: DenialStores;
    permission: ToolPermission;
    interaction: Interaction;
  },
): ToolGate {
  if (mode === AgentMode.Execution) return { kind: "run" };

  const blocked = blockedReason(mode, toolName, denials);
  if (blocked) return { kind: "block", reason: blocked };
  if (permission === "allow") return { kind: "run" };
  if (interaction === Interaction.Unavailable) {
    return { kind: "block", reason: deniedReason(mode, toolName, "there is no interactive UI to ask for approval") };
  }
  return { kind: "ask" };
}

export interface DenialStores {
  sessionDenials: ReadonlyMap<string, string | undefined>;
  alwaysDenials: ReadonlyMap<string, string | undefined>;
}

export function blockedReason(mode: RestrictedMode, toolName: string, { sessionDenials, alwaysDenials }: DenialStores): string | undefined {
  for (const [store, cause] of [
    [alwaysDenials, DENIAL_CAUSES["deny-always"]],
    [sessionDenials, DENIAL_CAUSES["deny-session"]],
  ] as const) {
    if (store.has(toolName)) return deniedReason(mode, toolName, cause, store.get(toolName));
  }
  return undefined;
}

// The snapshot lists what blockedReason enforces, so an always denial's note wins here as well.
export function effectiveDenials({ sessionDenials, alwaysDenials }: DenialStores): { name: string; note?: string }[] {
  const denials = new Map([...sessionDenials, ...alwaysDenials]);
  return [...denials].map(([name, note]) => (note ? { name, note } : { name }));
}

export const DENIAL_CAUSES = {
  "deny-session": "you denied it for this session",
  "deny-always": "you denied it for all sessions",
} as const;

export function deniedReason(mode: RestrictedMode, toolName: string, cause: string, note?: string): string {
  const reason =
    `${MODE_IDENTITIES[mode].label} is active and ${cause}, so ${toolName} did not run. ` +
    "Do not retry it.";
  if (note) return `${reason} Do this instead: ${note}`;
  const next = mode === AgentMode.Planning
    ? "or call submit_plan if the plan is ready."
    : "or finish the exploration and report your findings.";
  return `${reason} State what you need it for so the user can grant access, ${next}`;
}
