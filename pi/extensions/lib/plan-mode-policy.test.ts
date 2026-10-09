import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APPROVE,
  STAY,
  SubmissionAction,
  preferredThinkingLevel,
  submissionAction,
  thinkingLevelLabel,
} from "./plan-mode-policy.ts";

test("only an explicit approval approves", () => {
  // arrange
  const choices = [APPROVE, STAY, undefined, "Approve — leave plan mode", "Implement with different model"];

  // act
  const actions = choices.map((choice) => submissionAction(choice));

  // assert
  assert.deepEqual(actions, [
    SubmissionAction.Approve,
    SubmissionAction.Stay,
    SubmissionAction.Stay,
    SubmissionAction.Stay,
    SubmissionAction.Stay,
  ]);
});

test("the per-model level wins over the global default, which wins over medium", () => {
  // arrange
  const perModel = { modelThinkingLevels: { "capture/model": "low" }, defaultThinkingLevel: "high" };
  const otherModel = { modelThinkingLevels: { "capture/other": "low" }, defaultThinkingLevel: "high" };

  // act
  const levels = [
    preferredThinkingLevel("capture/model", perModel),
    preferredThinkingLevel("capture/model", otherModel),
    preferredThinkingLevel("capture/model", {}),
  ];

  // assert
  assert.deepEqual(levels, ["low", "high", "medium"]);
});

test("thinking level labels mark the default and the current level", () => {
  // arrange
  const levels = ["off", "low", "medium", "high"];

  // act
  const separate = levels.map((level) => thinkingLevelLabel(level, "high", "medium"));
  const together = levels.map((level) => thinkingLevelLabel(level, "high", "high"));

  // assert
  assert.deepEqual(separate, ["off", "low", "medium (current)", "high (default)"]);
  assert.deepEqual(together, ["off", "low", "medium", "high (default, current)"]);
});
