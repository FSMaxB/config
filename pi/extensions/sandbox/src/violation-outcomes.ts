import type { FilesystemConfig } from "@anthropic-ai/sandbox-runtime";
import type { AgentMode } from "../../lib/agent-mode.ts";
import { readOnlyRepositoryNotice } from "../../lib/path-permission-rules.ts";
import type { AccessMode } from "../../lib/path-permission-rules.ts";
import type { OnceGrant } from "../../lib/path-permissions.ts";
import { ALL_DURATIONS, LASTING_DURATIONS, userReason } from "../../lib/permission-prompt.ts";
import type { Duration } from "../../lib/permission-prompt.ts";
import { discardedWrites, parseViolation } from "./violations.ts";
import type { PathViolation } from "./violations.ts";
import type { Platform } from "./platform.ts";

export const CommandExit = { Succeeded: "succeeded", Failed: "failed" } as const;

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

// Seatbelt: `bazel(1975) deny(1) mach-lookup com.apple.DiskArbitration.diskarbitrationd`; the target is optional
// (`java(7027) deny(1) network-outbound`), and process names can contain spaces (`LM Studio(8890)`).
const SEATBELT_DENIAL = /^(?<processName>.+?)\(\d+\)\s+deny(?:\(\d+\))?\s+(?<operation>\S+)(?:\s+(?<target>.+))?$/;
// Process ids are the only difference between most repeated lines.
const PROCESS_ID = /\(\d+\)/g;
// Enough to name the dominant causes in one line; the full list file has the rest.
const MAX_SUMMARY_GROUPS = 8;
const MAX_TARGETS_PER_GROUP = 2;

// File denials and srt's proxy denials stay one line each, since only they lead to prompts or name a blocked host.
// Every other denial (mach-lookup, sysctl-read, system-info, direct network-outbound) is grouped by process and
// operation into one summary line.
export function violationBlock(lines: readonly string[]): ViolationBlock {
  const shown = new Map<string, string>();
  const collapsed: CollapsedDenial[] = [];
  for (const line of lines) {
    const denial = classifyDenial(line);
    if (denial.kind === "collapsed") collapsed.push(denial);
    else if (!shown.has(denial.key)) shown.set(denial.key, denial.line);
  }
  return new ViolationBlock([...shown.values()], groupDenials(collapsed));
}

export class ViolationBlock {
  readonly shown: readonly string[];
  readonly collapsed: readonly DenialGroup[];

  constructor(shown: readonly string[], collapsed: readonly DenialGroup[]) {
    this.shown = shown;
    this.collapsed = collapsed;
  }

  // fullListPath names the file with every raw line; undefined when it could not be written.
  render(fullListPath: string | undefined): string {
    const summary = this.collapsed.length === 0 ? [] : [summaryLine(this.collapsed, fullListPath)];
    return `\n<sandbox_violations>\n${[...this.shown, ...summary].join("\n")}\n</sandbox_violations>`;
  }
}

function classifyDenial(line: string): ClassifiedDenial {
  const shown: ClassifiedDenial = { kind: "shown", key: line.replace(PROCESS_ID, ""), line };
  if (parseViolation(line) !== undefined || NETWORK_DENIAL.test(line)) return shown;
  const groups = SEATBELT_DENIAL.exec(line)?.groups;
  const processName = groups?.processName;
  const operation = groups?.operation;
  if (processName === undefined || operation === undefined) return shown;
  return { kind: "collapsed", processName, operation, target: groups?.target };
}

function groupDenials(denials: readonly CollapsedDenial[]): DenialGroup[] {
  const byKey = new Map<string, CollapsedDenial[]>();
  for (const denial of denials) {
    const key = `${denial.processName}\u0000${denial.operation}`;
    const group = byKey.get(key);
    if (group) group.push(denial);
    else byKey.set(key, [denial]);
  }
  // Array.prototype.sort is stable, so equal counts keep their first-seen order.
  return [...byKey.values()].map(denialGroup).sort((left, right) => right.count - left.count);
}

function denialGroup(denials: readonly CollapsedDenial[]): DenialGroup {
  const first = denials.at(0);
  if (first === undefined) throw new Error("A denial group cannot be empty.");
  const targets = new Map<string, number>();
  for (const { target } of denials) if (target !== undefined) targets.set(target, (targets.get(target) ?? 0) + 1);
  const sortedTargets = new Map([...targets].sort(([, left], [, right]) => right - left));
  return { processName: first.processName, operation: first.operation, count: denials.length, targets: sortedTargets };
}

function summaryLine(groups: readonly DenialGroup[], fullListPath: string | undefined): string {
  const listed = groups.slice(0, MAX_SUMMARY_GROUPS).map(groupText);
  const remaining = groups.length - listed.length;
  const more = remaining > 0 ? ` and ${String(remaining)} more` : "";
  const file = fullListPath === undefined ? "" : ` Full list: ${fullListPath}`;
  return `Also denied, never prompted: ${listed.join(", ")}${more}.${file}`;
}

function groupText({ processName, operation, count, targets }: DenialGroup): string {
  const top = [...targets].slice(0, MAX_TARGETS_PER_GROUP).map(([target, targetCount]) => `${target} ×${String(targetCount)}`);
  const remaining = targets.size - top.length;
  const details = [...top, ...(remaining > 0 ? [`${String(remaining)} more`] : [])];
  return `${processName} ${operation} ×${String(count)}${details.length === 0 ? "" : ` (${details.join(", ")})`}`;
}

export interface DenialGroup {
  readonly processName: string;
  readonly operation: string;
  readonly count: number;
  // Target → count, most frequent first.
  readonly targets: ReadonlyMap<string, number>;
}

type ClassifiedDenial =
  | { kind: "shown"; key: string; line: string }
  | CollapsedDenial;

interface CollapsedDenial {
  kind: "collapsed";
  processName: string;
  operation: string;
  target: string | undefined;
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
export type CommandExit = (typeof CommandExit)[keyof typeof CommandExit];

function outcomeLine(outcome: ViolationOutcome, step: NextStep, agentMode: AgentMode): string {
  if (outcome.kind === "secret") return `${outcome.path} is on the sandbox secret list; no prompt can grant it, only a sandbox profile's filesystem.secretRead (reads only).`;
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

export type ViolationOutcome =
  | { kind: "secret"; path: string }
  | { kind: "no-ui"; mode: AccessMode; path: string }
  | { kind: "not-asked"; mode: AccessMode; path: string }
  | { kind: "allowed"; mode: AccessMode; path: string }
  | { kind: "allowed-once"; mode: AccessMode; path: string; grant: OnceGrant }
  | { kind: "added-to-profile"; mode: AccessMode; path: string; profile: string }
  | { kind: "denied"; mode: AccessMode; path: string; note: string | undefined };

export type NextStep = { kind: "rerun"; grants: OnceGrant[] } | { kind: "return" };

// srt records each refused connection as `deny network-outbound <host>:<port> (<reason>)`.
const NETWORK_DENIAL = /^deny network-outbound (.+):(\d+) \(/;

// Only denials with a user reason get a line; the violation block already lists the others.
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
