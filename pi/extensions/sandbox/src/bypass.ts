import { AgentMode, isRestricted } from "../../lib/agent-mode.ts";
import { ALLOW_ONCE, ALLOW_SESSION, DENY_ONCE, DENY_SESSION } from "../../lib/permission-choices.ts";

export type SessionDecision = "allow" | "deny";

export interface BypassSituation {
  agentMode: AgentMode;
  subagent: boolean;
  hasUI: boolean;
  sessionDecision: SessionDecision | undefined;
}

export type BypassAuthorization = { kind: "run" } | { kind: "refuse"; reason: string };
export type BypassOutcome = BypassAuthorization | { kind: "ask"; choices: string[]; defaultChoice: string };

const RETRY_HINT = "Do not retry with unsandboxed; run the command inside the sandbox or say what needs to run outside it.";

// Subagents run without a UI, and a child that could bypass the sandbox would undo the
// restrictions its parent inherited, so they are refused before any prompt is attempted.
export function bypassOutcome({ agentMode, subagent, hasUI, sessionDecision }: BypassSituation): BypassOutcome {
  if (subagent) return { kind: "refuse", reason: `Subagents cannot run commands outside the sandbox. ${RETRY_HINT}` };
  if (sessionDecision === "allow") return { kind: "run" };
  if (sessionDecision === "deny") return { kind: "refuse", reason: `The user denied unsandboxed commands for this session. ${RETRY_HINT}` };
  if (!hasUI) return { kind: "refuse", reason: `Running outside the sandbox needs the user's confirmation and there is no interactive UI to ask. ${RETRY_HINT}` };
  // Plan and explore mode are read-only by design, so the preselected answer flips to deny there.
  return { kind: "ask", choices: [ALLOW_ONCE, ALLOW_SESSION, DENY_ONCE, DENY_SESSION], defaultChoice: isRestricted(agentMode) ? DENY_ONCE : ALLOW_ONCE };
}

export function resolveChoice(choice: string | undefined): { authorization: BypassAuthorization; remember: SessionDecision | undefined } {
  if (choice === ALLOW_ONCE) return { authorization: { kind: "run" }, remember: undefined };
  if (choice === ALLOW_SESSION) return { authorization: { kind: "run" }, remember: "allow" };
  return {
    authorization: { kind: "refuse", reason: `The user denied running this command outside the sandbox. ${RETRY_HINT}` },
    remember: choice === DENY_SESSION ? "deny" : undefined,
  };
}

export function bypassPrompt(command: string): string {
  const MAX_COMMAND_LENGTH = 200;
  const shown = command.length > MAX_COMMAND_LENGTH ? `${command.slice(0, MAX_COMMAND_LENGTH - 3)}...` : command;
  return `Sandbox: run this command outside the sandbox?\n\n  ${shown}`;
}
