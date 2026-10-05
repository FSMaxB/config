import assert from "node:assert/strict";
import { test } from "node:test";
import { activateMissingPlanTools } from "./plan-tools.ts";

test("the migration appends only missing planning tools and keeps unrelated order", () => {
  // arrange
  const calls: string[][] = [];
  let active = ["write", "plan_path", "read"];
  const pi = {
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      calls.push(names);
      active = names;
    },
  };

  // act
  activateMissingPlanTools(pi);
  activateMissingPlanTools(pi);

  // assert
  assert.deepEqual(calls, [["write", "plan_path", "read", "submit_plan"]]);
});
