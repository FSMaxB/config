import assert from "node:assert/strict";
import test from "node:test";
import { AgentMode } from "../../lib/agent-mode.ts";
import { tree } from "../../lib/path-permission-rules.ts";
import { nextStep, violationReport, type ViolationOutcome } from "./violation-outcomes.ts";

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
