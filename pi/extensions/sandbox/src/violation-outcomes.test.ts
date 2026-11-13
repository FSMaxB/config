import assert from "node:assert/strict";
import test from "node:test";
import { AgentMode } from "../../lib/agent-mode.ts";
import { tree } from "../../lib/path-permission-rules.ts";
import { networkDenialReport, nextStep, successViolationReport, violationReport, type ViolationOutcome } from "./violation-outcomes.ts";

const grant = { mode: "read" as const, selector: tree("/outside") };
const allowedOnce: ViolationOutcome = { kind: "allowed-once", mode: "read", path: "/outside/a", grant };

test("reruns with the once grants when every denied path was granted", () => {
  // arrange
  const outcomes: ViolationOutcome[] = [allowedOnce, { kind: "allowed", mode: "write", path: "/repo/b" }];

  // act
  const step = nextStep(outcomes);

  // assert
  assert.deepEqual(step, { kind: "rerun", grants: [grant] });
});

test("does not rerun when another path was denied", () => {
  // arrange
  const outcomes: ViolationOutcome[] = [allowedOnce, { kind: "denied", mode: "write", path: "/repo/b", note: undefined }];

  // act
  const step = nextStep(outcomes);

  // assert
  assert.deepEqual(step, { kind: "return" });
});

test("does not rerun without a once grant", () => {
  // arrange
  const outcomes: ViolationOutcome[] = [{ kind: "allowed", mode: "write", path: "/repo/b" }];

  // act
  const step = nextStep(outcomes);

  // assert
  assert.deepEqual(step, { kind: "return" });
});

test("does not rerun when a path was not asked about", () => {
  // arrange
  const outcomes: ViolationOutcome[] = [allowedOnce, { kind: "not-asked", mode: "read", path: "/outside/c" }];

  // act
  const step = nextStep(outcomes);

  // assert
  assert.deepEqual(step, { kind: "return" });
});

test("the rerun report announces the rerun output", () => {
  // arrange
  const outcomes: ViolationOutcome[] = [allowedOnce];

  // act
  const report = violationReport(outcomes, { kind: "rerun", grants: [grant] }, AgentMode.Execution);

  // assert
  assert.ok(report.includes("was allowed for one rerun."));
  assert.ok(report.endsWith("the rerun's output follows.\n"));
  assert.ok(!report.includes("rerun the command."));
});

test("a denied path with a note repeats the user's reason", () => {
  // arrange
  const outcomes: ViolationOutcome[] = [{ kind: "denied", mode: "read", path: "/repo/private/key", note: "keys inside" }];

  // act
  const report = violationReport(outcomes, { kind: "return" }, AgentMode.Execution);

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
  assert.equal(withoutNotes, "");
});

test("a persistent grant alone tells the agent to rerun", () => {
  // arrange
  const outcomes: ViolationOutcome[] = [{ kind: "allowed", mode: "write", path: "/repo/b" }];

  // act
  const report = violationReport(outcomes, { kind: "return" }, AgentMode.Execution);

  // assert
  assert.ok(report.includes("was granted; rerun the command."));
});

test("a successful command without violations gets no report", () => {
  // arrange
  const filesystem = { denyRead: ["/home/max"], allowWrite: ["/home/max/repo"] };

  // act
  const report = successViolationReport([], filesystem, "linux", AgentMode.Execution);

  // assert
  assert.equal(report, "");
});

test("a denied write on macOS is reported as denied, not discarded", () => {
  // arrange
  const filesystem = { denyRead: ["/Users/max"], allowWrite: [] };
  const violations = [{ mode: "write" as const, path: "/Users/max/repo" }];

  // act
  const report = successViolationReport(violations, filesystem, "darwin", AgentMode.Execution);

  // assert
  assert.ok(report.includes("write access to /Users/max/repo was denied by the sandbox; the command still exited 0."));
  assert.ok(!report.includes("discarded"));
});

test("a discarded write on a successful command is reported, with the explore-mode notice", () => {
  // arrange
  const filesystem = { denyRead: ["/home/max"], allowWrite: ["/home/max/repo"] };
  const violations = [{ mode: "write" as const, path: "/home/max/notes.txt" }];

  // act
  const report = successViolationReport(violations, filesystem, "linux", AgentMode.Exploring);

  // assert
  assert.ok(report.startsWith("\n<sandbox_violations>\n"));
  assert.ok(report.endsWith("\n</sandbox_violations>\n"));
  assert.ok(report.includes("/home/max/notes.txt is not covered by the write path rules; the write was discarded and nothing reached the real filesystem."));
  assert.ok(report.includes("Explore mode is on, so the repository is read-only until the user leaves it."));
});

test("a non-discarded violation on a successful command is reported as denied but still exit 0", () => {
  // arrange
  const filesystem = { denyRead: ["/home/max/.ssh"], allowWrite: ["/home/max/repo"] };
  const violations = [
    { mode: "read" as const, path: "/home/max/.ssh/config" },
    { mode: "write" as const, path: "/etc/passwd" },
  ];

  // act
  const report = successViolationReport(violations, filesystem, "linux", AgentMode.Execution);

  // assert
  assert.ok(report.includes("read access to /home/max/.ssh/config was denied by the sandbox; the command still exited 0."));
  assert.ok(report.includes("write access to /etc/passwd was denied by the sandbox; the command still exited 0."));
  assert.ok(!report.includes("discarded"));
  assert.ok(!report.includes("read-only"));
});

test("a successful command can mix discarded and plainly denied violations in one block", () => {
  // arrange
  const filesystem = { denyRead: ["/home/max"], allowWrite: ["/home/max/repo"] };
  const violations = [
    { mode: "write" as const, path: "/home/max/notes.txt" },
    { mode: "read" as const, path: "/home/max/other.txt" },
  ];

  // act
  const report = successViolationReport(violations, filesystem, "linux", AgentMode.Planning);

  // assert
  assert.ok(report.includes("/home/max/notes.txt is not covered by the write path rules; the write was discarded and nothing reached the real filesystem."));
  assert.ok(report.includes("read access to /home/max/other.txt was denied by the sandbox; the command still exited 0."));
  assert.ok(report.includes("Plan mode is on, so the repository is read-only until the user approves a plan."));
});

test("a path added to a profile alone triggers a rerun without grants", () => {
  // arrange
  const outcomes: ViolationOutcome[] = [{ kind: "added-to-profile", mode: "write", path: "/cache/a", profile: "bazel" }];

  // act
  const step = nextStep(outcomes);

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
  const step = nextStep(outcomes);

  // assert
  assert.deepEqual(step, { kind: "return" });
});

test("the report says a path was added to the profile and when to rerun", () => {
  // arrange
  const outcomes: ViolationOutcome[] = [{ kind: "added-to-profile", mode: "write", path: "/cache/a", profile: "bazel" }];

  // act
  const rerun = violationReport(outcomes, { kind: "rerun", grants: [] }, AgentMode.Execution);
  const returned = violationReport(outcomes, { kind: "return" }, AgentMode.Execution);

  // assert
  assert.match(rerun, /write access to \/cache\/a was added to profile bazel\./);
  assert.doesNotMatch(rerun, /rerun the command\./);
  assert.match(returned, /was added to profile bazel; rerun the command\./);
});
