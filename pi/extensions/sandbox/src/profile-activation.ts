import type { AgentMode } from "../../lib/agent-mode.ts";
import { isRestricted } from "../../lib/agent-mode.ts";
import { ALLOW_ONCE, ALLOW_SESSION } from "../../lib/permission-choices.ts";
import { Duration, userReason } from "../../lib/permission-prompt.ts";
import type { PermissionAnswer } from "../../lib/permission-prompt.ts";
import type { SessionGrant } from "../../lib/session-grants.ts";
import type { TriggerMatch } from "./profile-triggers.ts";
import { NetworkAccess } from "./profiles.ts";
import type { ActivationDecisions, Profile, ProfileNetwork } from "./profiles.ts";
import { isRecord } from "../../lib/untyped.ts";
import { shortenedCommand } from "./command-text.ts";

export const PROFILE_ENTRY_TYPE = "sandbox-profiles";

// Session decisions beat the stored ones, as for network grants.
export function activationOutcome(profile: Profile, state: ProfileSessionState, { agentMode, hasUI, always }: ActivationSituation): ActivationOutcome {
  const { name } = profile;
  if (state.denied.has(name)) return { kind: "refuse", reason: `The user denied sandbox profile ${name} for this session.${userReason(state.denied.get(name))}` };
  if (state.allowed.has(name)) return { kind: "activate" };
  if (always.denied.has(name)) return { kind: "refuse", reason: `The user always denies sandbox profile ${name}.${userReason(always.denied.get(name))}` };
  if (always.allowed.has(name)) return { kind: "activate" };
  if (!hasUI) return { kind: "refuse", reason: `Activating sandbox profile ${name} needs the user's confirmation and there is no interactive UI to ask.` };
  return { kind: "ask", preselected: isRestricted(agentMode) ? ALLOW_ONCE : ALLOW_SESSION };
}

export interface ActivationSituation {
  agentMode: AgentMode;
  hasUI: boolean;
  always: ActivationDecisions;
}

// An outcome that needs no prompt, in the shape an answered prompt resolves to. An activation comes from a decision that is
// already stored, so remembering it again would only append a session entry on every call.
export function settledResolution(outcome: Exclude<ActivationOutcome, { kind: "ask" }>): ActivationResolution {
  if (outcome.kind === "refuse") return { kind: "refuse", reason: outcome.reason, remember: undefined, persist: undefined };
  return { kind: "activate", remember: undefined, persist: undefined };
}

export type ActivationOutcome =
  | { kind: "activate" }
  | { kind: "refuse"; reason: string }
  | { kind: "ask"; preselected: string };

export function resolveActivationAnswer(profile: Profile, answer: PermissionAnswer<string>): ActivationResolution {
  if (answer.decision === "allow") {
    return {
      kind: "activate",
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

export type ActivationResolution =
  | { kind: "activate"; remember: RecordedDecision | undefined; persist: RecordedDecision | undefined }
  | { kind: "refuse"; reason: string; remember: RecordedDecision | undefined; persist: RecordedDecision | undefined };

// What to remember for the session, or to persist in sandbox.json's profileActivation lists. Never written into the profile.
export type RecordedDecision = { decision: "allow" } | { decision: "deny"; note: string | undefined };

// Entries per list in the prompt; the prompt has to fit on screen next to its options.
const LIST_LIMIT = 5;

export function activationPrompt(profile: Profile, origin: ActivationOrigin): string {
  const { filesystem, network, path } = profile;
  const lines = [
    `Sandbox: activate profile "${profile.name}"?`,
    "",
    `  ${originText(origin)}`,
    ...listLine("read", filesystem.read),
    ...listLine("write", filesystem.write),
    ...listLine("read secrets", filesystem.secretRead),
    ...listLine("hosts", network.allowedDomains),
    ...listLine("unix sockets", network.allowUnixSockets),
    ...(network.allowLocalBinding ? ["  local binding: yes"] : []),
    ...(network.enableWeakerNetworkIsolation ? ["  trustd (Go TLS verification, weaker network isolation): yes"] : []),
    ...networkAccessLine(network.access),
    ...listLine("PATH", path),
    "",
    "  Applies to this bash call only. \"In session\" and \"always\" apply it without asking whenever a command triggers or requests it.",
    ...(hasNetwork(network) ? ["  Its network access is shared with bash calls running at the same time."] : []),
  ];
  return lines.join("\n");
}

function originText(origin: ActivationOrigin): string {
  if (origin.kind === "request") return `Requested by the agent for: ${shortened(origin.command)}`;
  const trigger = origin.match.kind === "command" ? `\`${origin.match.command}\`` : `pattern ${origin.match.pattern}`;
  return `Triggered by ${trigger} in: ${shortened(origin.command)}`;
}

export type ActivationOrigin = { kind: "trigger"; match: TriggerMatch; command: string } | { kind: "request"; command: string };

function shortened(command: string): string {
  return shortenedCommand(command, " ");
}

function listLine(label: string, entries: readonly string[]): string[] {
  if (entries.length === 0) return [];
  const shown = entries.slice(0, LIST_LIMIT).join(", ");
  const rest = entries.length - LIST_LIMIT;
  return [`  ${label}: ${rest > 0 ? `${shown}, … (+${rest} more)` : shown}`];
}

function networkAccessLine(access: NetworkAccess): string[] {
  switch (access) {
    case NetworkAccess.Listed: return [];
    case NetworkAccess.Local: return ["  network: everything on this host (listen on any port, connect to localhost)"];
    case NetworkAccess.All: return ["  network: every host"];
  }
}

function hasNetwork({ access, allowedDomains, allowLocalBinding, allowUnixSockets, enableWeakerNetworkIsolation }: ProfileNetwork): boolean {
  return access !== NetworkAccess.Listed || allowLocalBinding || enableWeakerNetworkIsolation || allowedDomains.length > 0 || allowUnixSockets.length > 0;
}

export function profileSessionGrants({ allowed, denied }: ProfileSessionState): SessionGrant[] {
  return [
    ...[...allowed].sort().map((name) => ({ kind: "profile", decision: "allow", name }) as const),
    ...[...denied.keys()].sort().map((name) => ({ kind: "profile", decision: "deny", name }) as const),
  ];
}

export function serializeProfileState({ allowed, denied }: ProfileSessionState): { allowed: string[]; denied: Record<string, string | null> } {
  // eslint-disable-next-line unicorn/no-null -- sandbox.json stores a denial without a note as null
  return { allowed: [...allowed], denied: Object.fromEntries([...denied].map(([name, note]) => [name, note ?? null])) };
}

export function parseProfileState(value: unknown): ProfileSessionState {
  const state = emptyProfileState();
  if (!isRecord(value)) return state;
  const { allowed, active, denied } = value;
  // An "active" list (a profile applied to every call) is read as approvals, the narrower meaning.
  const names = allowed ?? active;
  if (Array.isArray(names)) for (const name of names) if (typeof name === "string") state.allowed.add(name);
  if (isRecord(denied)) {
    for (const [name, note] of Object.entries(denied)) state.denied.set(name, typeof note === "string" ? note : undefined);
  }
  return state;
}

export function emptyProfileState(): ProfileSessionState {
  return { allowed: new Set(), denied: new Map() };
}

export interface ProfileSessionState {
  // Applied without asking whenever a bash call triggers or requests them.
  allowed: Set<string>;
  // The value is the user's reason, repeated to the agent whenever the denial applies.
  denied: Map<string, string | undefined>;
}
