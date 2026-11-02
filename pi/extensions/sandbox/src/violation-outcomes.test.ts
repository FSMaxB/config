import assert from "node:assert/strict";
import test from "node:test";
import { AgentMode } from "../../lib/agent-mode.ts";
import { tree } from "../../lib/path-permission-rules.ts";
import { nextStep, successViolationReport, violationReport, type ViolationOutcome } from "./violation-outcomes.ts";

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
  const outcomes: ViolationOutcome[] = [allowedOnce, { kind: "denied", mode: "write", path: "/repo/b" }];

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
  const report = successViolationReport([], filesystem, AgentMode.Execution);

  // assert
  assert.equal(report, "");
});

test("a discarded write on a successful command is reported, with the explore-mode notice", () => {
  // arrange
  const filesystem = { denyRead: ["/home/max"], allowWrite: ["/home/max/repo"] };
  const violations = [{ mode: "write" as const, path: "/home/max/notes.txt" }];

  // act
  const report = successViolationReport(violations, filesystem, AgentMode.Exploring);

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
  const report = successViolationReport(violations, filesystem, AgentMode.Execution);

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
  const report = successViolationReport(violations, filesystem, AgentMode.Planning);

  // assert
  assert.ok(report.includes("/home/max/notes.txt is not covered by the write path rules; the write was discarded and nothing reached the real filesystem."));
  assert.ok(report.includes("read access to /home/max/other.txt was denied by the sandbox; the command still exited 0."));
  assert.ok(report.includes("Plan mode is on, so the repository is read-only until the user approves a plan."));
});
