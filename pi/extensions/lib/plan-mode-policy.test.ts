import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APPROVE,
  APPROVE_CURRENT,
  IMPLEMENT_DIFFERENT,
  REFINE,
  STAY,
  SubmissionAction,
  submissionAction,
  submissionOptions,
} from "./plan-mode-policy.ts";

test("submission options offer the suggested model first and approve with the current one", () => {
  // arrange
  const suggested = "capture/other";

  // act
  const withSuggestion = submissionOptions(suggested);
  const withoutSuggestion = submissionOptions(undefined);

  // assert
  assert.deepEqual(withSuggestion, [
    "Approve — implement with capture/other (suggested)",
    APPROVE_CURRENT,
    IMPLEMENT_DIFFERENT,
    REFINE,
    STAY,
  ]);
  assert.deepEqual(withoutSuggestion, [APPROVE, IMPLEMENT_DIFFERENT, REFINE, STAY]);
});

test("each submission choice maps to its action", () => {
  // arrange
  const suggested = "capture/other";
  const [approveSuggested] = submissionOptions(suggested);

  // act
  const actions = [
    submissionAction(approveSuggested, suggested),
    submissionAction(APPROVE_CURRENT, suggested),
    submissionAction(APPROVE, undefined),
    submissionAction(IMPLEMENT_DIFFERENT, undefined),
    submissionAction(REFINE, undefined),
  ];

  // assert
  assert.deepEqual(actions, [
    SubmissionAction.ApproveSuggested,
    SubmissionAction.Approve,
    SubmissionAction.Approve,
    SubmissionAction.ImplementDifferent,
    SubmissionAction.Refine,
  ]);
});

test("staying, dismissing the dialog and unoffered choices keep plan mode on", () => {
  // arrange
  const choices = [STAY, undefined, APPROVE_CURRENT, "Approve — implement with capture/other (suggested)"];

  // act
  const actions = choices.map((choice) => submissionAction(choice, undefined));

  // assert
  assert.deepEqual(actions, Array(choices.length).fill(SubmissionAction.Stay));
});
