import assert from "node:assert/strict";
import { it } from "node:test";
import { isCritPlanApproved } from "./crit-approval.ts";

for (const [stderr, expected] of [
  ["approved: true\n", true],
  ["Review ready\napproved: true\n", true],
  ["approved: true\r\n", true],
  ["approved: false\n", false],
  ["", false],
  ["No comments", false],
  ["The user approved: true", false],
  [" approved: true\n", false],
  ["approved: true \n", false],
  ["approved: TRUE\n", false],
  ["approved: true\napproved: true\n", false],
  ["approved: true\napproved: false\n", false],
  ["approved: true\napproved: invalid\n", false],
] as const) {
  it(`recognizes only unambiguous Crit approval: ${JSON.stringify(stderr)}`, () => {
    // arrange
    const status = stderr;
    // act
    const approved = isCritPlanApproved(status);
    // assert
    assert.equal(approved, expected);
  });
}
