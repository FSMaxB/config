import assert from "node:assert/strict";
import { test } from "node:test";
import { deniedToolDeclarations } from "./plan-loadout.ts";

test("loadouts hide only explicit tool denials, not approval-required tools or path rules", () => {
  // arrange
  const declared = ["denied", "needs-approval", "read", "plan_path"].map(name => ({ name }));
  // act
  const hidden = deniedToolDeclarations(declared, new Set(["denied", "/private/file", "absent", "plan_path"]));
  // assert
  assert.deepEqual(hidden, ["denied", "plan_path"]);
  assert.deepEqual(declared.map(tool => tool.name), ["denied", "needs-approval", "read", "plan_path"]);
});

test("removing or clearing a denial immediately changes the projection", () => {
  // arrange
  const denied = new Set(["read", "write"]);
  const declared = [{ name: "read" }, { name: "write" }];
  // act
  denied.delete("read");
  const afterRemoval = deniedToolDeclarations(declared, denied);
  denied.clear();
  const afterClear = deniedToolDeclarations(declared, denied);
  // assert
  assert.deepEqual(afterRemoval, ["write"]);
  assert.deepEqual(afterClear, []);
});
