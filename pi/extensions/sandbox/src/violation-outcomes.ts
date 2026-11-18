import type { FilesystemConfig } from "@anthropic-ai/sandbox-runtime";
import type { AgentMode } from "../../lib/agent-mode.ts";
import { readOnlyRepositoryNotice } from "../../lib/path-permission-rules.ts";
import type { AccessMode } from "../../lib/path-permission-rules.ts";
import type { OnceGrant } from "../../lib/path-permissions.ts";
import { ALL_DURATIONS, LASTING_DURATIONS, userReason } from "../../lib/permission-prompt.ts";
import type { Duration } from "../../lib/permission-prompt.ts";
import { discardedWrites } from "./violations.ts";
import type { PathViolation } from "./violations.ts";
import type { Platform } from "./platform.ts";

export type ViolationOutcome =
  | { kind: "secret"; path: string }
  | { kind: "no-ui"; mode: AccessMode; path: string }
  | { kind: "not-asked"; mode: AccessMode; path: string }
  | { kind: "allowed"; mode: AccessMode; path: string }
  | { kind: "allowed-once"; mode: AccessMode; path: string; grant: OnceGrant }
  | { kind: "added-to-profile"; mode: AccessMode; path: string; profile: string }
  | { kind: "denied"; mode: AccessMode; path: string; note: string | undefined };

export type NextStep = { kind: "rerun"; grants: OnceGrant[] } | { kind: "return" };

export const CommandExit = { Succeeded: "succeeded", Failed: "failed" } as const;
export type CommandExit = (typeof CommandExit)[keyof typeof CommandExit];

// A command that exited 0 is never rerun, so a once grant would have nothing to apply to.
export function promptDurations(exit: CommandExit): readonly Duration[] {
  return exit === CommandExit.Succeeded ? LASTING_DURATIONS : ALL_DURATIONS;
}

// A path that is still blocked would fail the rerun the same way, so a rerun needs every path granted. A path
// added to a profile contributes no once grant: the rerun reloads the profile. A command that exited 0 is never
// rerun: its side effects already happened once.
export function nextStep(outcomes: readonly ViolationOutcome[], exit: CommandExit): NextStep {
  if (exit === CommandExit.Succeeded) return { kind: "return" };
  const grants = outcomes.flatMap((outcome) => outcome.kind === "allowed-once" ? [outcome.grant] : []);
  const rerunnable = outcomes.some(({ kind }) => kind === "allowed-once" || kind === "added-to-profile");
  const blocked = outcomes.some(({ kind }) => kind !== "allowed" && kind !== "allowed-once" && kind !== "added-to-profile");
  return !rerunnable || blocked ? { kind: "return" } : { kind: "rerun", grants };
}

// The raw lines, for the model to see what else the command ran into besides the path denials below them.
export function rawViolationBlock(lines: readonly string[]): string {
  return `\n<sandbox_violations>\n${lines.join("\n")}\n</sandbox_violations>`;
}

export function violationReport(outcomes: readonly ViolationOutcome[], step: NextStep, agentMode: AgentMode, exit: CommandExit): string {
  const lines = outcomes.map((outcome) => outcomeLine(outcome, step, agentMode));
  return `\n${[...lines, ...reportFooter(step, exit)].join("\n")}\n`;
}

function reportFooter(step: NextStep, exit: CommandExit): string[] {
  if (step.kind === "rerun") return ["Rerunning the command with these grants; the rerun's output follows."];
  if (exit === CommandExit.Succeeded) return ["The command exited 0, but the denied operations did not take effect, so its result can be incomplete. It was not rerun."];
  return [];
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
    case "added-to-profile": return step.kind === "rerun"
      ? `${mode} access to ${path} was added to profile ${outcome.profile}.`
      : `${mode} access to ${path} was added to profile ${outcome.profile}; rerun the command.`;
    case "denied": return `${mode} access to ${path} was denied; do not retry it.${userReason(outcome.note)}${notice}`;
  }
}

// srt records each refused connection as `deny network-outbound <host>:<port> (<reason>)`.
const NETWORK_DENIAL = /^deny network-outbound (.+):(\d+) \(/;

// Only denials with a user reason get a line; the raw block already lists the others.
export function networkDenialReport(lines: readonly string[], noteFor: (host: string, port: number) => string | undefined): string | undefined {
  const reported = new Map<string, string>();
  for (const line of lines) {
    const match = NETWORK_DENIAL.exec(line);
    if (!match) continue;
    const [, host, port] = match;
    const destination = `${host}:${port}`;
    const note = noteFor(host, Number(port));
    if (note && !reported.has(destination)) reported.set(destination, `Network access to ${destination} was denied by the user; do not retry it.${userReason(note)}`);
  }
  return reported.size === 0 ? undefined : `\n${[...reported.values()].join("\n")}\n`;
}

export const HERE_DOCUMENT_REPORT =
  "\nThe shell could not create a here-document temp file (sh-thd-*) in the current directory: bash before 5.1 ignores $TMPDIR for them. Write file content with the write tool, or `cd \"$TMPDIR\"` first and use absolute paths.\n";

// Linux's read-deny tmpfs accepts writes and drops them when the sandbox exits, so the program believes they
// succeeded; macOS refuses such writes, so it never reports any.
export function discardedWriteReport(
  violations: readonly PathViolation[],
  filesystem: Pick<FilesystemConfig, "denyRead" | "allowWrite">,
  platform: Platform,
): string | undefined {
  const discarded = discardedWrites(violations, filesystem, platform);
  if (discarded.length === 0) return undefined;
  return `\n${discarded.map(({ path }) => `The write to ${path} was discarded; nothing reached the real filesystem.`).join("\n")}\n`;
}
