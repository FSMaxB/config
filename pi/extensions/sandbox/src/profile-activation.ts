import { AgentMode, isRestricted } from "../../lib/agent-mode.ts";
import { ALLOW_ONCE, ALLOW_SESSION } from "../../lib/permission-choices.ts";
import { Duration, userReason, type PermissionAnswer } from "../../lib/permission-prompt.ts";
import type { SessionGrant } from "../../lib/session-grants.ts";
import type { TriggerMatch } from "./profile-triggers.ts";
import type { ActivationDecisions, Profile } from "./profiles.ts";

export const PROFILE_ENTRY_TYPE = "sandbox-profiles";

export const ActivationScope = { Once: "once", Session: "session" } as const;
export type ActivationScope = (typeof ActivationScope)[keyof typeof ActivationScope];

export interface ProfileSessionState {
  active: Set<string>;
  // The value is the user's reason, repeated to the agent whenever the denial applies.
  denied: Map<string, string | undefined>;
  // Profiles activated for the next bash call only. Never persisted.
  pendingOnce: Set<string>;
}

export type ActivationOrigin = { kind: "trigger"; match: TriggerMatch; command: string } | { kind: "tool" };

export interface ActivationSituation {
  agentMode: AgentMode;
  hasUI: boolean;
  always: ActivationDecisions;
}

export type ActivationOutcome =
  | { kind: "activate"; scope: ActivationScope }
  | { kind: "refuse"; reason: string }
  | { kind: "ask"; preselected: string };

// What to remember for the session, or to persist in sandbox.json's profileActivation lists. Never written into the profile.
export type RecordedDecision = { decision: "allow" } | { decision: "deny"; note: string | undefined };

export type ActivationResolution =
  | { kind: "activate"; scope: ActivationScope; remember: RecordedDecision | undefined; persist: RecordedDecision | undefined }
  | { kind: "refuse"; reason: string; remember: RecordedDecision | undefined; persist: RecordedDecision | undefined };

export function emptyProfileState(): ProfileSessionState {
  return { active: new Set(), denied: new Map(), pendingOnce: new Set() };
}

// Session decisions beat the stored ones, as for network grants.
export function activationOutcome(profile: Profile, state: ProfileSessionState, { agentMode, hasUI, always }: ActivationSituation): ActivationOutcome {
  const { name } = profile;
  if (state.denied.has(name)) return { kind: "refuse", reason: `The user denied sandbox profile ${name} for this session.${userReason(state.denied.get(name))}` };
  if (always.denied.has(name)) return { kind: "refuse", reason: `The user always denies sandbox profile ${name}.${userReason(always.denied.get(name))}` };
  if (always.allowed.has(name)) return { kind: "activate", scope: ActivationScope.Session };
  if (!hasUI) return { kind: "refuse", reason: `Activating sandbox profile ${name} needs the user's confirmation and there is no interactive UI to ask.` };
  return { kind: "ask", preselected: isRestricted(agentMode) ? ALLOW_ONCE : ALLOW_SESSION };
}

// An outcome that needs no prompt, in the shape an answered prompt resolves to. Activation from stored decisions lasts for the session.
export function settledResolution(outcome: Exclude<ActivationOutcome, { kind: "ask" }>): ActivationResolution {
  if (outcome.kind === "refuse") return { kind: "refuse", reason: outcome.reason, remember: undefined, persist: undefined };
  return { kind: "activate", scope: outcome.scope, remember: { decision: "allow" }, persist: undefined };
}

export function resolveActivationAnswer(profile: Profile, answer: PermissionAnswer<string>): ActivationResolution {
  if (answer.decision === "allow") {
    const scope = answer.duration === Duration.Once ? ActivationScope.Once : ActivationScope.Session;
    return {
      kind: "activate",
      scope,
      remember: answer.duration === Duration.Once ? undefined : { decision: "allow" },
      persist: answer.duration === Duration.Always ? { decision: "allow" } : undefined,
    };
  }
  const denial: RecordedDecision = { decision: "deny", note: answer.note };
  return {
    kind: "refuse",
    reason: `The user denied sandbox profile ${profile.name}.${userReason(answer.note)}`,
    remember: answer.duration === Duration.Once ? undefined : denial,
    persist: answer.duration === Duration.Always ? denial : undefined,
  };
}

const LIST_LIMIT = 5;
const COMMAND_HEAD = 120;
const COMMAND_TAIL = 120;

export function activationPrompt(profile: Profile, origin: ActivationOrigin): string {
  const { filesystem, network, path } = profile;
  const lines = [
    `Sandbox: activate profile "${profile.name}"?`,
    "",
    `  ${originText(origin)}`,
    ...listLine("read", filesystem.read),
    ...listLine("write", filesystem.write),
    ...listLine("hosts", network.allowedDomains),
    ...listLine("unix sockets", network.allowUnixSockets),
    ...(network.allowLocalBinding ? ["  local binding: yes"] : []),
    ...listLine("PATH", path),
    "",
    "  An active profile applies to every bash call.",
  ];
  return lines.join("\n");
}

function originText(origin: ActivationOrigin): string {
  if (origin.kind === "tool") return "Requested by the agent";
  const trigger = origin.match.kind === "command" ? `\`${origin.match.command}\`` : `pattern ${origin.match.pattern}`;
  return `Triggered by ${trigger} in: ${shortened(origin.command)}`;
}

// The tail matters more than the head here: an unexpected suffix on a long command is where a payload hides.
function shortened(command: string): string {
  if (command.length <= COMMAND_HEAD + COMMAND_TAIL + 32) return command;
  return `${command.slice(0, COMMAND_HEAD)} …[${command.length - COMMAND_HEAD - COMMAND_TAIL} characters omitted]… ${command.slice(-COMMAND_TAIL)}`;
}

function listLine(label: string, entries: readonly string[]): string[] {
  if (entries.length === 0) return [];
  const shown = entries.slice(0, LIST_LIMIT).join(", ");
  const rest = entries.length - LIST_LIMIT;
  return [`  ${label}: ${rest > 0 ? `${shown}, … (+${rest} more)` : shown}`];
}

export function profileSessionGrants({ active, denied }: ProfileSessionState): SessionGrant[] {
  return [
    ...[...active].sort().map((name) => ({ kind: "profile", decision: "allow", name }) as const),
    ...[...denied.keys()].sort().map((name) => ({ kind: "profile", decision: "deny", name }) as const),
  ];
}

export function serializeProfileState({ active, denied }: ProfileSessionState): { active: string[]; denied: Record<string, string | null> } {
  return { active: [...active], denied: Object.fromEntries([...denied].map(([name, note]) => [name, note ?? null])) };
}

export function parseProfileState(value: unknown): ProfileSessionState {
  const state = emptyProfileState();
  if (typeof value !== "object" || value === null) return state;
  const { active, denied } = value as { active?: unknown; denied?: unknown };
  if (Array.isArray(active)) for (const name of active) if (typeof name === "string") state.active.add(name);
  if (typeof denied === "object" && denied !== null && !Array.isArray(denied)) {
    for (const [name, note] of Object.entries(denied)) state.denied.set(name, typeof note === "string" ? note : undefined);
  }
  return state;
}
