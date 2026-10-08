import type { CredentialEnvVarConfig } from "@anthropic-ai/sandbox-runtime";

// Names that conventionally hold credentials. Masked rather than unset so tools
// that legitimately need the value keep working: srt swaps in a sentinel inside
// the sandbox and the proxy substitutes the real value on egress to allowed domains.
const SENSITIVE_NAME = /(api[_-]?key|access[_-]?key|secret|token|password|passwd|credential|private[_-]?key)/i;

export function credentialEnvVars(environment: NodeJS.ProcessEnv = process.env): CredentialEnvVarConfig[] {
  return Object.keys(environment)
    .filter((name) => SENSITIVE_NAME.test(name) && environment[name] !== "")
    .sort()
    .map((name) => ({ name, mode: "mask" }));
}
