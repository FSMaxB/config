// Decisions about subagents on providers outside the session model's family, and the text of the prompt that
// asks for them. Only pure imports, so the module stays runnable in isolation for testing.

import { Duration, userReason } from "../lib/permission-prompt.ts";
import type { PermissionAnswer } from "../lib/permission-prompt.ts";
import type { SessionGrant } from "../lib/session-grants.ts";
import { isRecord } from "../lib/untyped.ts";
import type { ProviderVerdict } from "./model-policy.ts";

// Bumped when the shape of subagent-providers.json changes incompatibly.
export const PROVIDER_DECISIONS_VERSION = 1;

export function emptyProviderDecisions(): ProviderDecisions {
  return new ProviderDecisions(new Set(), new Map());
}

// Malformed entries are dropped; a different version is rejected so a newer file is never overwritten.
export function parseProviderDecisions(value: unknown): ProviderDecisionsParse {
  if (!isRecord(value)) return { ok: false, error: "is not a JSON object" };
  if (value.version !== PROVIDER_DECISIONS_VERSION) {
    return { ok: false, error: `has version ${String(value.version)}, expected ${PROVIDER_DECISIONS_VERSION}` };
  }
  const allowed = Array.isArray(value.allowed)
    ? value.allowed.filter((entry): entry is string => typeof entry === "string")
    : [];
  const denied = new Map<string, string | undefined>();
  if (Array.isArray(value.denied)) {
    for (const entry of value.denied) {
      if (!isRecord(entry) || typeof entry.provider !== "string") continue;
      if (entry.note !== undefined && typeof entry.note !== "string") continue;
      denied.set(entry.provider, entry.note);
    }
  }
  return { ok: true, decisions: new ProviderDecisions(new Set(allowed), denied) };
}

// Session decisions beat the stored ones, as for sandbox profiles and network grants.
export function settleProvider(provider: string, { session, always, hasUI }: ProviderSituation): ProviderOutcome {
  const sessionDecision = session.decisionFor(provider);
  if (sessionDecision?.decision === "deny") {
    return { kind: "deny", reason: `The user denied subagents on provider ${provider} for this session.${userReason(sessionDecision.note)}` };
  }
  if (sessionDecision?.decision === "allow") return { kind: "allow" };
  const alwaysDecision = always.decisionFor(provider);
  if (alwaysDecision?.decision === "deny") {
    return { kind: "deny", reason: `The user always denies subagents on provider ${provider}.${userReason(alwaysDecision.note)}` };
  }
  if (alwaysDecision?.decision === "allow") return { kind: "allow" };
  if (!hasUI) {
    return { kind: "deny", reason: `Subagents on provider ${provider} need the user's approval and there is no interactive UI to ask.` };
  }
  return { kind: "ask" };
}

// One prompt can cover several providers; its answer is resolved per provider.
export function resolveProviderAnswer(provider: string, answer: PermissionAnswer<readonly string[]>): ProviderResolution {
  if (answer.decision === "allow") {
    const allow: RecordedDecision = { decision: "allow" };
    return {
      verdict: { kind: "allow" },
      remember: answer.duration === Duration.Once ? undefined : allow,
      persist: answer.duration === Duration.Always ? allow : undefined,
    };
  }
  const denial: RecordedDecision = { decision: "deny", note: answer.note };
  return {
    verdict: { kind: "deny", reason: `The user denied subagents on provider ${provider}.${userReason(answer.note)}` },
    remember: answer.duration === Duration.Once ? undefined : denial,
    persist: answer.duration === Duration.Always ? denial : undefined,
  };
}

export function crossProviderPrompt(sessionModel: string | undefined, models: readonly string[], providers: readonly string[]): string {
  return [
    "Subagent: use a model from another provider?",
    "",
    `  Session model: ${sessionModel ?? "none"}`,
    `  Requested: ${models.join(", ")}`,
    "",
    `  "In session" and "always" cover every model of ${providerList(providers)}. Each call still needs crossProvider: true.`,
  ].join("\n");
}

export function providerList(providers: readonly string[]): string {
  const last = providers.at(-1);
  if (providers.length < 2 || last === undefined) return providers.join("");
  return `${providers.slice(0, -1).join(", ")} and ${last}`;
}

export type ProviderDecisionsParse = { ok: true; decisions: ProviderDecisions } | { ok: false; error: string };

export interface ProviderSituation {
  session: ProviderDecisions;
  always: ProviderDecisions;
  hasUI: boolean;
}

export type ProviderOutcome = ProviderVerdict | { kind: "ask" };

export interface ProviderResolution {
  verdict: ProviderVerdict;
  // For the session tier.
  remember: RecordedDecision | undefined;
  // For the always tier.
  persist: RecordedDecision | undefined;
}

// The remembered decisions of one tier (session or always), keyed by provider.
export class ProviderDecisions {
  readonly allowed: ReadonlySet<string>;
  // The value is the user's reason, repeated to the agent whenever the denial applies.
  readonly denied: ReadonlyMap<string, string | undefined>;

  constructor(allowed: ReadonlySet<string>, denied: ReadonlyMap<string, string | undefined>) {
    this.allowed = allowed;
    this.denied = denied;
  }

  decisionFor(provider: string): RecordedDecision | undefined {
    if (this.denied.has(provider)) return { decision: "deny", note: this.denied.get(provider) };
    if (this.allowed.has(provider)) return { decision: "allow" };
    return undefined;
  }

  record(provider: string, decision: RecordedDecision): ProviderDecisions {
    const remaining = this.forget(provider);
    if (decision.decision === "allow") return new ProviderDecisions(new Set([...remaining.allowed, provider]), remaining.denied);
    return new ProviderDecisions(remaining.allowed, new Map([...remaining.denied, [provider, decision.note]]));
  }

  forget(provider: string): ProviderDecisions {
    return new ProviderDecisions(
      new Set([...this.allowed].filter((candidate) => candidate !== provider)),
      new Map([...this.denied].filter(([candidate]) => candidate !== provider)),
    );
  }

  has(provider: string): boolean {
    return this.allowed.has(provider) || this.denied.has(provider);
  }

  // For argument completion.
  providers(): string[] {
    return [...new Set([...this.allowed, ...this.denied.keys()])].sort();
  }

  rows(): string[] {
    return this.providers().map((provider) => {
      const note = this.denied.get(provider);
      if (this.denied.has(provider)) return note ? `✗ ${provider} (${note})` : `✗ ${provider}`;
      return `✓ ${provider}`;
    });
  }

  sessionGrants(): SessionGrant[] {
    return [
      ...[...this.allowed].sort().map((provider) => ({ kind: "subagent-provider", decision: "allow", provider }) as const),
      ...[...this.denied.keys()].sort().map((provider) => ({ kind: "subagent-provider", decision: "deny", provider }) as const),
    ];
  }

  toJson(): ProviderDecisionsFile {
    return {
      version: PROVIDER_DECISIONS_VERSION,
      allowed: [...this.allowed].sort(),
      denied: [...this.denied]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([provider, note]) => (note === undefined ? { provider } : { provider, note })),
    };
  }
}

export type RecordedDecision = { decision: "allow" } | { decision: "deny"; note: string | undefined };

export interface ProviderDecisionsFile {
  version: number;
  allowed: string[];
  denied: { provider: string; note?: string }[];
}

