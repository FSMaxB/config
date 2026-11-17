import { Buffer } from "node:buffer";
import { isAbsolute } from "node:path";
import { AgentMode, isPathRuleStore, type PathRuleStore } from "./agent-mode.ts";
import { emptyRules, parseRules, selectorKey, type PathSelector, type RuleSets, type SerializedRules } from "./path-permission-rules.ts";

// ruleStore and agentMode describe the parent; parents that predate them omit them.
export interface ChildPathPolicy { version: 1; session: SerializedRules; readDefaults: PathSelector[]; writeDefaults: PathSelector[]; ruleStore?: PathRuleStore; agentMode?: AgentMode }
export const CHILD_POLICY_ENV = "PI_SUBAGENT_PATH_POLICY";
const MAX_BYTES = 32 * 1024;

export function serializeChildPathPolicy(policy: ChildPathPolicy): string {
  const encoded = JSON.stringify(policy);
  if (Buffer.byteLength(encoded, "utf8") > MAX_BYTES) throw new Error("Inherited path policy exceeds the 32 KiB limit.");
  return encoded;
}
export function parseChildPathPolicy(value: string | undefined): ChildPathPolicy | null | undefined {
  if (value === undefined) return undefined;
  if (Buffer.byteLength(value, "utf8") > MAX_BYTES) return null;
  try {
    const policy = JSON.parse(value) as ChildPathPolicy;
    if (policy.version !== 1 || !policy.session || !Array.isArray(policy.readDefaults) || !Array.isArray(policy.writeDefaults)) return null;
    if (policy.ruleStore !== undefined && !isPathRuleStore(policy.ruleStore)) return null;
    if (policy.agentMode !== undefined && !Object.values(AgentMode).includes(policy.agentMode)) return null;
    parseRules(policy.session);
    parseRules({ version: 2, read: { allow: policy.readDefaults, deny: [] }, write: { allow: policy.writeDefaults, deny: [] } });
    const selectors = [...policy.readDefaults, ...policy.writeDefaults,
      ...(["read", "write"] as const).flatMap((mode) => [...policy.session[mode].allow, ...policy.session[mode].deny])];
    if (!selectors.every((selector) => isAbsolute(selector.kind === "glob" ? selector.base : selector.path))) return null;
    return policy;
  } catch { return null; }
}
export function inheritedRules(policy: ChildPathPolicy): RuleSets {
  const rules = emptyRules();
  for (const mode of ["read", "write"] as const) {
    for (const selector of policy.session[mode].allow) rules[mode].allow.add(selectorKey(selector));
    for (const entry of policy.session[mode].deny) rules[mode].deny.set(selectorKey(entry), entry.note);
  }
  return rules;
}
