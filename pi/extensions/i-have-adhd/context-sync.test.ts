import assert from "node:assert/strict";
import test from "node:test";
import { ContextChange, requiredContextChange } from "./context-sync.ts";

test("the context change follows the mode and whether the rules are in context", () => {
  // arrange
  const cases = [
    { enabled: true, rulesInContext: false },
    { enabled: false, rulesInContext: true },
    { enabled: true, rulesInContext: true },
    { enabled: false, rulesInContext: false },
  ];

  // act
  const results = cases.map(({ enabled, rulesInContext }) =>
    requiredContextChange(enabled, rulesInContext),
  );

  // assert
  assert.deepEqual(results, [
    ContextChange.InjectRules,
    ContextChange.DisableRules,
    ContextChange.None,
    ContextChange.None,
  ]);
});
