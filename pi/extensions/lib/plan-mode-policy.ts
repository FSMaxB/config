import type { PlanModeEntry } from "./plan-mode-entry.ts";
import { PlanModeState } from "./plan-mode-messages.ts";
import type { ToolPermission } from "./tool-permission-policy.ts";

// The decisions plan-mode.ts makes, kept free of pi imports so they run under plain node tests;
// plan-mode.ts itself only wires them to the session, the UI and the stores.

export const StartupRequest = { None: "none", Plan: "plan", Handoff: "handoff" } as const;
export type StartupRequest = (typeof StartupRequest)[keyof typeof StartupRequest];
export const StateRecording = { Keep: "keep", Record: "record" } as const;
export type StateRecording = (typeof StateRecording)[keyof typeof StateRecording];

// A fresh handoff session exists to implement an approved plan, so the --plan flag does not apply
// to it. Subagents read the recorded state, so a mode the branch does not record yet is recorded.
export function startupPlanMode(
  restored: PlanModeEntry | undefined,
  request: StartupRequest,
): { enabled: boolean; recording: StateRecording } {
  const enabled = request === StartupRequest.Plan || (restored?.enabled ?? false);
  const recording = restored?.enabled === enabled ? StateRecording.Keep : StateRecording.Record;
  return { enabled, recording };
}

export const Interaction = { Available: "available", Unavailable: "unavailable" } as const;
export type Interaction = (typeof Interaction)[keyof typeof Interaction];
export type ToolGate = { kind: "run" } | { kind: "block"; reason: string } | { kind: "ask" };

export function toolGate(
  toolName: string,
  { mode, denials, permission, interaction }: {
    mode: PlanModeState;
    denials: DenialStores;
    permission: ToolPermission;
    interaction: Interaction;
  },
): ToolGate {
  if (mode === PlanModeState.Execution) return { kind: "run" };

  const blocked = blockedReason(toolName, denials);
  if (blocked) return { kind: "block", reason: blocked };
  if (permission === "allow") return { kind: "run" };
  if (interaction === Interaction.Unavailable) {
    return { kind: "block", reason: deniedReason(toolName, "there is no interactive UI to ask for approval") };
  }
  return { kind: "ask" };
}

export interface DenialStores {
  sessionDenials: ReadonlyMap<string, string | undefined>;
  alwaysDenials: ReadonlyMap<string, string | undefined>;
}

export function blockedReason(toolName: string, { sessionDenials, alwaysDenials }: DenialStores): string | undefined {
  for (const [store, cause] of [
    [alwaysDenials, DENIAL_CAUSES["deny-always"]],
    [sessionDenials, DENIAL_CAUSES["deny-session"]],
  ] as const) {
    if (store.has(toolName)) return deniedReason(toolName, cause, store.get(toolName));
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

export function deniedReason(toolName: string, cause: string, note?: string): string {
  const reason =
    `Plan mode is active and ${cause}, so ${toolName} did not run. ` +
    "Do not retry it.";
  return note
    ? `${reason} Do this instead: ${note}`
    : `${reason} State what you need it for so the user can grant access, or call submit_plan if the plan is ready.`;
}

export const SubmissionAction = {
  ApproveSuggested: "approve-suggested",
  Approve: "approve",
  ImplementDifferent: "implement-different",
  Refine: "refine",
  Stay: "stay",
} as const;
export type SubmissionAction = (typeof SubmissionAction)[keyof typeof SubmissionAction];

export const APPROVE = "Approve — leave plan mode";
export const APPROVE_CURRENT = "Approve — implement with current model";
export const IMPLEMENT_DIFFERENT = "Implement with different model";
export const REFINE = "Refine — send feedback";
export const STAY = "Stay in plan mode";

export function submissionOptions(suggestedModel: string | undefined): string[] {
  return [
    ...(suggestedModel ? [approveSuggestedLabel(suggestedModel)] : []),
    suggestedModel ? APPROVE_CURRENT : APPROVE,
    IMPLEMENT_DIFFERENT,
    REFINE,
    STAY,
  ];
}

// Anything that is not an offered option, a dismissed dialog included, keeps plan mode on.
export function submissionAction(choice: string | undefined, suggestedModel: string | undefined): SubmissionAction {
  if (choice === undefined || !submissionOptions(suggestedModel).includes(choice)) return SubmissionAction.Stay;
  if (suggestedModel && choice === approveSuggestedLabel(suggestedModel)) return SubmissionAction.ApproveSuggested;
  if (choice === APPROVE || choice === APPROVE_CURRENT) return SubmissionAction.Approve;
  if (choice === IMPLEMENT_DIFFERENT) return SubmissionAction.ImplementDifferent;
  if (choice === REFINE) return SubmissionAction.Refine;
  return SubmissionAction.Stay;
}

function approveSuggestedLabel(suggestedModel: string): string {
  return `Approve — implement with ${suggestedModel} (suggested)`;
}
