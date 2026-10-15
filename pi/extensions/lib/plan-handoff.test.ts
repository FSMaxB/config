import assert from "node:assert/strict";
import test from "node:test";
import { isPlanHandoffSession } from "./plan-handoff.ts";

test("a session seeded with a plan-handoff entry is a handoff session", () => {
  // arrange
  const sessionManager = {
    getEntries: () => [{ type: "custom", customType: "plan-handoff", data: { planPath: "/p" } }],
  };

  // act
  const result = isPlanHandoffSession(sessionManager);

  // assert
  assert.equal(result, true);
});

test("a session without a plan-handoff entry is not a handoff session", () => {
  // arrange
  const sessionManager = { getEntries: () => [{ type: "message" }] };

  // act
  const result = isPlanHandoffSession(sessionManager);

  // assert
  assert.equal(result, false);
});
