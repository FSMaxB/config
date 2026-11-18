import { Buffer } from "node:buffer";
import { isAbsolute } from "node:path";
import { isAgentMode, isPathRuleStore } from "./agent-mode.ts";
import type { AgentMode, PathRuleStore } from "./agent-mode.ts";
import { emptyRules, parseRules, selectorFromKey, selectorKey, serializeRules } from "./path-permission-rules.ts";
import type { PathSelector, RuleSets, SerializedRules } from "./path-permission-rules.ts";
import { isRecord } from "./untyped.ts";
import { BYTES_PER_KIBIBYTE } from "./units.ts";
export const CHILD_POLICY_ENV = "PI_SUBAGENT_PATH_POLICY";
// The policy travels in an environment variable, and an exec fails with E2BIG once the
// environment outgrows the system limit (256 KiB on macOS, shared with the arguments).
const MAX_KIBIBYTES = 32;
const MAX_BYTES = MAX_KIBIBYTES * BYTES_PER_KIBIBYTE;

const INVALID: InheritedPolicy = { kind: "invalid" };

export function serializeChildPathPolicy(policy: ChildPathPolicy): string {
  const encoded = JSON.stringify(policy);
  if (Buffer.byteLength(encoded, "utf8") > MAX_BYTES) throw new Error(`Inherited path policy exceeds the ${MAX_KIBIBYTES} KiB limit.`);
  return encoded;
}

export function parseChildPathPolicy(value: string | undefined): InheritedPolicy {
  if (value === undefined) return { kind: "none" };
  if (Buffer.byteLength(value, "utf8") > MAX_BYTES) return INVALID;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || parsed.version !== 1) return INVALID;
    const { ruleStore, agentMode } = parsed;
    if (ruleStore !== undefined && !isPathRuleStore(ruleStore)) return INVALID;
    if (agentMode !== undefined && !isAgentMode(agentMode)) return INVALID;
    if (!Array.isArray(parsed.readDefaults) || !Array.isArray(parsed.writeDefaults)) return INVALID;
    const session = parseRules(parsed.session);
    const defaults = parseRules({ version: 2, read: { allow: parsed.readDefaults, deny: [] }, write: { allow: parsed.writeDefaults, deny: [] } });
    const readDefaults = [...defaults.read.allow].map(selectorFromKey);
    const writeDefaults = [...defaults.write.allow].map(selectorFromKey);
    const selectors = [...readDefaults, ...writeDefaults,
      ...(["read", "write"] as const).flatMap((mode) => [...session[mode].allow, ...session[mode].deny.keys()].map(selectorFromKey))];
    if (!selectors.every((selector) => isAbsolute(selector.kind === "glob" ? selector.base : selector.path))) return INVALID;
    return { kind: "valid", policy: { version: 1, session: serializeRules(session), readDefaults, writeDefaults, ruleStore, agentMode } };
  } catch {
    return INVALID;
  }
}

// A child process without the variable is not a subagent; one with an invalid variable must not
// fall back to its own rules, so it disables the path tools instead.
export type InheritedPolicy = { kind: "none" } | { kind: "invalid" } | { kind: "valid"; policy: ChildPathPolicy };

export function inheritedRules(policy: ChildPathPolicy): RuleSets {
  const rules = emptyRules();
  for (const mode of ["read", "write"] as const) {
    for (const selector of policy.session[mode].allow) rules[mode].allow.add(selectorKey(selector));
    for (const entry of policy.session[mode].deny) rules[mode].deny.set(selectorKey(entry), entry.note);
  }
  return rules;
}

// ruleStore and agentMode describe the parent; without them the child uses its own.
export interface ChildPathPolicy { version: 1; session: SerializedRules; readDefaults: PathSelector[]; writeDefaults: PathSelector[]; ruleStore?: PathRuleStore; agentMode?: AgentMode }
