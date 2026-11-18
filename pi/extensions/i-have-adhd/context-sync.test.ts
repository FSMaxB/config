import assert from "node:assert/strict";
import test from "node:test";
import { ContextChange, requiredContextChange } from "./context-sync.ts";

test("the context change follows the mode and whether the rules are in context", () => {
  // arrange
  const cases = [
    { mode: "enabled", rules: "missing" },
    { mode: "disabled", rules: "in-context" },
    { mode: "enabled", rules: "in-context" },
    { mode: "disabled", rules: "missing" },
  ] as const;

  // act
  const results = cases.map(({ mode, rules }) => requiredContextChange(mode, rules));

  // assert
  assert.deepEqual(results, [
    ContextChange.InjectRules,
    ContextChange.DisableRules,
    ContextChange.None,
    ContextChange.None,
  ]);
});
