import type { AgentMode } from "../../lib/agent-mode.ts";
import { readOnlyRepositoryNotice, type AccessMode } from "../../lib/path-permission-rules.ts";
import type { OnceGrant } from "../../lib/path-permissions.ts";

export type ViolationOutcome =
  | { kind: "secret"; path: string }
  | { kind: "no-ui"; mode: AccessMode; path: string }
  | { kind: "not-asked"; mode: AccessMode; path: string }
  | { kind: "allowed"; mode: AccessMode; path: string }
  | { kind: "allowed-once"; mode: AccessMode; path: string; grant: OnceGrant }
  | { kind: "denied"; mode: AccessMode; path: string };

export type NextStep = { kind: "rerun"; grants: OnceGrant[] } | { kind: "return" };

// A path that is still blocked would fail the rerun the same way, so a rerun needs every path granted.
export function nextStep(outcomes: ViolationOutcome[]): NextStep {
  const grants = outcomes.flatMap((outcome) => outcome.kind === "allowed-once" ? [outcome.grant] : []);
  const blocked = outcomes.some(({ kind }) => kind !== "allowed" && kind !== "allowed-once");
  return grants.length === 0 || blocked ? { kind: "return" } : { kind: "rerun", grants };
}

export function violationReport(outcomes: ViolationOutcome[], step: NextStep, agentMode: AgentMode): string {
  const lines = outcomes.map((outcome) => outcomeLine(outcome, step, agentMode));
  const footer = step.kind === "rerun" ? ["Rerunning the command with these grants; the rerun's output follows."] : [];
  return `\n${[...lines, ...footer].join("\n")}\n`;
}

function outcomeLine(outcome: ViolationOutcome, step: NextStep, agentMode: AgentMode): string {
  if (outcome.kind === "secret") return `${outcome.path} is on the sandbox secret list and cannot be granted.`;
  const { mode, path } = outcome;
  const notice = readOnlyRepositoryNotice(mode, agentMode);
  switch (outcome.kind) {
    case "no-ui": return `${path} is not covered by the ${mode} path rules and there is no interactive UI to ask.${notice}`;
    case "not-asked": return `${path} is not covered by the ${mode} path rules; too many paths were denied to ask about each one.${notice}`;
    case "allowed": return step.kind === "rerun" ? `${mode} access to ${path} was granted.` : `${mode} access to ${path} was granted; rerun the command.`;
    case "allowed-once": return step.kind === "rerun"
      ? `${mode} access to ${path} was allowed for one rerun.`
      : `${mode} access to ${path} was allowed once, but the command was not rerun because other paths are still blocked.`;
    case "denied": return `${mode} access to ${path} was denied; do not retry it.${notice}`;
  }
}
