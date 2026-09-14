import { Buffer } from "node:buffer";
import type { PathSelector, RuleSets, SerializedRules } from "./path-permission-rules.ts";

export interface ChildPathPolicy { version: 1; session: SerializedRules; readDefaults: PathSelector[]; writeDefaults: PathSelector[] }
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
    return policy;
  } catch { return null; }
}
export function inheritedRules(policy: ChildPathPolicy): RuleSets {
  const rules = emptyRules();
  for (const mode of ["read", "write"] as const) for (const kind of ["allow", "deny"] as const) for (const selector of policy.session[mode][kind]) rules[mode][kind].add(JSON.stringify(selector.kind === "glob" ? [selector.kind, selector.base, selector.pattern] : [selector.kind, selector.path]));
  return rules;
}
function emptyRules(): RuleSets { return { read: { allow: new Set(), deny: new Set() }, write: { allow: new Set(), deny: new Set() } }; }
