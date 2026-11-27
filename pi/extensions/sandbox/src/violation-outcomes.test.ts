import assert from "node:assert/strict";
import test from "node:test";
import { AgentMode } from "../../lib/agent-mode.ts";
import { tree } from "../../lib/path-permission-rules.ts";
import { ALL_DURATIONS, LASTING_DURATIONS } from "../../lib/permission-prompt.ts";
import { CommandExit, discardedWriteReport, networkDenialReport, nextStep, promptDurations, violationBlock, violationReport } from "./violation-outcomes.ts";
import type { ViolationOutcome } from "./violation-outcomes.ts";

const grant = { mode: "read" as const, selector: tree("/outside") };
const allowedOnce: ViolationOutcome = { kind: "allowed-once", mode: "read", path: "/outside/a", grant };

test("reruns with the once grants when every denied path was granted", () => {
  // arrange
  const outcomes: ViolationOutcome[] = [allowedOnce, { kind: "allowed", mode: "write", path: "/repo/b" }];

  // act
  const step = nextStep(outcomes, CommandExit.Failed);

  // assert
  assert.deepEqual(step, { kind: "rerun", grants: [grant] });
});

test("does not rerun when another path was denied", () => {
  // arrange
  const outcomes: ViolationOutcome[] = [allowedOnce, { kind: "denied", mode: "write", path: "/repo/b", note: undefined }];

  // act
  const step = nextStep(outcomes, CommandExit.Failed);

  // assert
  assert.deepEqual(step, { kind: "return" });
});

test("does not rerun without a once grant", () => {
  // arrange
  const outcomes: ViolationOutcome[] = [{ kind: "allowed", mode: "write", path: "/repo/b" }];

  // act
  const step = nextStep(outcomes, CommandExit.Failed);

  // assert
  assert.deepEqual(step, { kind: "return" });
});

test("does not rerun when a path was not asked about", () => {
  // arrange
  const outcomes: ViolationOutcome[] = [allowedOnce, { kind: "not-asked", mode: "read", path: "/outside/c" }];

  // act
  const step = nextStep(outcomes, CommandExit.Failed);

  // assert
  assert.deepEqual(step, { kind: "return" });
});

test("the rerun report announces the rerun output", () => {
  // arrange
  const outcomes: ViolationOutcome[] = [allowedOnce];

  // act
  const report = violationReport(outcomes, { kind: "rerun", grants: [grant] }, AgentMode.Execution, CommandExit.Failed);

  // assert
  assert.ok(report.includes("was allowed for one rerun."));
  assert.ok(report.endsWith("the rerun's output follows.\n"));
  assert.ok(!report.includes("rerun the command."));
});

test("a denied path with a note repeats the user's reason", () => {
  // arrange
  const outcomes: ViolationOutcome[] = [{ kind: "denied", mode: "read", path: "/repo/private/key", note: "keys inside" }];

  // act
  const report = violationReport(outcomes, { kind: "return" }, AgentMode.Execution, CommandExit.Failed);

  // assert
  assert.ok(report.includes("read access to /repo/private/key was denied; do not retry it. The user's reason: keys inside"));
});

test("the network report has one line per denied destination that has a note", () => {
  // arrange
  const lines = [
    "deny network-outbound example.com:80 (proxy)",
    "deny network-outbound example.com:80 (proxy)",
    "deny network-outbound other.example:443 (proxy)",
    "deny http-request example.com:80 (proxy)",
    "deny file-read-data /etc/passwd",
  ];
  const noteFor = (host: string, port: number) => host === "example.com" && port === 80 ? "use https" : undefined;

  // act
  const report = networkDenialReport(lines, noteFor);
  const withoutNotes = networkDenialReport(lines, () => undefined);

  // assert
  assert.equal(report, "\nNetwork access to example.com:80 was denied by the user; do not retry it. The user's reason: use https\n");
  assert.equal(withoutNotes, undefined);
});

test("a persistent grant alone tells the agent to rerun", () => {
  // arrange
  const outcomes: ViolationOutcome[] = [{ kind: "allowed", mode: "write", path: "/repo/b" }];

  // act
  const report = violationReport(outcomes, { kind: "return" }, AgentMode.Execution, CommandExit.Failed);

  // assert
  assert.ok(report.includes("was granted; rerun the command."));
});

test("a path added to a profile alone triggers a rerun without grants", () => {
  // arrange
  const outcomes: ViolationOutcome[] = [{ kind: "added-to-profile", mode: "write", path: "/cache/a", profile: "bazel" }];

  // act
  const step = nextStep(outcomes, CommandExit.Failed);

  // assert
  assert.deepEqual(step, { kind: "rerun", grants: [] });
});

test("a path added to a profile does not rerun while another path is blocked", () => {
  // arrange
  const outcomes: ViolationOutcome[] = [
    { kind: "added-to-profile", mode: "write", path: "/cache/a", profile: "bazel" },
    { kind: "denied", mode: "read", path: "/other", note: undefined },
  ];

  // act
  const step = nextStep(outcomes, CommandExit.Failed);

  // assert
  assert.deepEqual(step, { kind: "return" });
});

test("the report says a path was added to the profile and when to rerun", () => {
  // arrange
  const outcomes: ViolationOutcome[] = [{ kind: "added-to-profile", mode: "write", path: "/cache/a", profile: "bazel" }];

  // act
  const rerun = violationReport(outcomes, { kind: "rerun", grants: [] }, AgentMode.Execution, CommandExit.Failed);
  const returned = violationReport(outcomes, { kind: "return" }, AgentMode.Execution, CommandExit.Failed);

  // assert
  assert.match(rerun, /write access to \/cache\/a was added to profile bazel\./);
  assert.doesNotMatch(rerun, /rerun the command\./);
  assert.match(returned, /was added to profile bazel; rerun the command\./);
});

test("a successful command is never rerun, even when every path was allowed once or added to a profile", () => {
  // arrange
  const outcomes: ViolationOutcome[] = [allowedOnce, { kind: "added-to-profile", mode: "write", path: "/cache/a", profile: "bazel" }];

  // act
  const step = nextStep(outcomes, CommandExit.Succeeded);

  // assert
  assert.deepEqual(step, { kind: "return" });
});

test("prompts for a successful command offer no once duration", () => {
  // act
  const succeeded = promptDurations(CommandExit.Succeeded);
  const failed = promptDurations(CommandExit.Failed);

  // assert
  assert.deepEqual(succeeded, LASTING_DURATIONS);
  assert.deepEqual(failed, ALL_DURATIONS);
});

test("the report of a successful command asks for a rerun and says the command exited 0", () => {
  // arrange
  const outcomes: ViolationOutcome[] = [{ kind: "added-to-profile", mode: "write", path: "/cache/a", profile: "bazel" }];

  // act
  const report = violationReport(outcomes, { kind: "return" }, AgentMode.Execution, CommandExit.Succeeded);

  // assert
  assert.match(report, /was added to profile bazel; rerun the command\./);
  assert.match(report, /The command exited 0, but the denied operations did not take effect/);
});

test("the report of a failed command has no exit-0 footer", () => {
  // arrange
  const outcomes: ViolationOutcome[] = [{ kind: "allowed", mode: "write", path: "/repo/b" }];

  // act
  const report = violationReport(outcomes, { kind: "return" }, AgentMode.Execution, CommandExit.Failed);

  // assert
  assert.doesNotMatch(report, /exited 0/);
});

test("a discarded write on Linux gets its own line", () => {
  // arrange
  const filesystem = { denyRead: ["/home/max"], allowWrite: ["/home/max/repo"] };
  const violations = [
    { mode: "write" as const, path: "/home/max/notes.txt" },
    { mode: "read" as const, path: "/home/max/other.txt" },
  ];

  // act
  const report = discardedWriteReport(violations, filesystem, "linux");

  // assert
  assert.equal(report, "\nThe write to /home/max/notes.txt was discarded; nothing reached the real filesystem.\n");
});

test("macOS and commands without discarded writes get no discarded-write report", () => {
  // arrange
  const filesystem = { denyRead: ["/Users/max"], allowWrite: [] };
  const violations = [{ mode: "write" as const, path: "/Users/max/notes.txt" }];

  // act
  const macOS = discardedWriteReport(violations, filesystem, "darwin");
  const empty = discardedWriteReport([], filesystem, "linux");

  // assert
  assert.equal(macOS, undefined);
  assert.equal(empty, undefined);
});

test("a violation block keeps file and proxy denials and collapses the rest into one summary line", () => {
  // arrange
  const lines = [
    "grep(83330) deny(1) file-read-data /Volumes/External/test.log",
    "grep(83331) deny(1) file-read-data /Volumes/External/test.log",
    "deny network-outbound example.com:443 (not allowed)",
    "bazel(1975) deny(1) mach-lookup com.apple.DiskArbitration.diskarbitrationd",
    "bazel(1976) deny(1) mach-lookup com.apple.DiskArbitration.diskarbitrationd",
    "bazel(1975) deny(1) mach-lookup com.apple.CoreServices.coreservicesd",
    "java(7027) deny(1) network-outbound",
  ];
  const expected = [
    "",
    "<sandbox_violations>",
    "grep(83330) deny(1) file-read-data /Volumes/External/test.log",
    "deny network-outbound example.com:443 (not allowed)",
    "Also denied, never prompted: bazel mach-lookup ×3 (com.apple.DiskArbitration.diskarbitrationd ×2, com.apple.CoreServices.coreservicesd ×1), java network-outbound ×1. Full list: /scratch/list.log",
    "</sandbox_violations>",
  ].join("\n");

  // act
  const rendered = violationBlock(lines).render("/scratch/list.log");

  // assert
  assert.equal(rendered, expected);
});

test("a violation block without collapsed denials has no summary line", () => {
  // arrange
  const lines = ["cat(1) deny(1) file-read-data /Users/max/secret.txt"];
  const expected = "\n<sandbox_violations>\ncat(1) deny(1) file-read-data /Users/max/secret.txt\n</sandbox_violations>";

  // act
  const block = violationBlock(lines);

  // assert
  assert.equal(block.collapsed.length, 0);
  assert.equal(block.render(undefined), expected);
});

test("the summary line names only the largest groups and the two most frequent targets", () => {
  // arrange
  const lines = Array.from({ length: 10 }, (_, index) => `tool${String(index)}(1) deny(1) mach-lookup a`)
    .concat(["big(1) deny(1) sysctl-read x", "big(1) deny(1) sysctl-read x", "big(1) deny(1) sysctl-read y", "big(1) deny(1) sysctl-read z"]);

  // act
  const rendered = violationBlock(lines).render(undefined);

  // assert
  assert.match(rendered, /^Also denied, never prompted: big sysctl-read ×4 \(x ×2, y ×1, 1 more\), tool0 mach-lookup ×1 \(a ×1\)/m);
  assert.match(rendered, / and 3 more\.$/m);
});
