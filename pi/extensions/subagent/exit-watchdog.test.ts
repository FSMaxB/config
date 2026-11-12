import assert from "node:assert/strict";
import { test } from "node:test";
import { phaseAfterEvent } from "./exit-watchdog.ts";

test("a final agent_end or compaction_end finishes the child", () => {
  // arrange
  const events = [{ type: "agent_end", willRetry: false }, { type: "agent_end" }, { type: "compaction_end", willRetry: false }];

  // act
  const phases = events.map((event) => phaseAfterEvent("working", event));

  // assert
  assert.deepEqual(phases, ["finished", "finished", "finished"]);
});

test("an end followed by a retry keeps the child working", () => {
  // arrange
  const events = [{ type: "agent_end", willRetry: true }, { type: "compaction_end", willRetry: true }];

  // act
  const phases = events.map((event) => phaseAfterEvent("working", event));

  // assert
  assert.deepEqual(phases, ["working", "working"]);
});

test("new work after an end puts the child back to working", () => {
  // arrange
  const events = [{ type: "agent_start" }, { type: "auto_retry_start" }, { type: "compaction_start" }];

  // act
  const phases = events.map((event) => phaseAfterEvent("finished", event));

  // assert
  assert.deepEqual(phases, ["working", "working", "working"]);
});

test("other events keep the current phase", () => {
  // arrange
  const event = { type: "message_end" };

  // act
  const phases = [phaseAfterEvent("working", event), phaseAfterEvent("finished", event), phaseAfterEvent("finished", {})];

  // assert
  assert.deepEqual(phases, ["working", "finished", "finished"]);
});
