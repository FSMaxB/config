import assert from "node:assert/strict";
import test from "node:test";
import { coveredProtectedSelectors, glob, tree, exact, type PathSelector } from "./path-permission-rules.ts";

test("a tree grant covers a protected root nested inside it", () => {
  // arrange
  const grant = tree("/home/user");
  const protectedSelectors: PathSelector[] = [tree("/home/user/.pi/agent/extensions"), tree("/root/other")];

  // act
  const covered = coveredProtectedSelectors(grant, protectedSelectors);

  // assert
  assert.deepEqual(covered, [tree("/home/user/.pi/agent/extensions")]);
});

test("an exact grant covers the identical protected root", () => {
  // arrange
  const grant = exact("/home/user/.pi/agent/extensions");
  const protectedSelectors: PathSelector[] = [tree("/home/user/.pi/agent/extensions")];

  // act
  const covered = coveredProtectedSelectors(grant, protectedSelectors);

  // assert
  assert.deepEqual(covered, [tree("/home/user/.pi/agent/extensions")]);
});

test("a glob grant covers nothing", () => {
  // arrange
  const grant = glob("/home/user", "**");
  const protectedSelectors: PathSelector[] = [tree("/home/user/.pi/agent/extensions")];

  // act
  const covered = coveredProtectedSelectors(grant, protectedSelectors);

  // assert
  assert.deepEqual(covered, []);
});

test("an unrelated tree covers nothing", () => {
  // arrange
  const grant = tree("/opt/work");
  const protectedSelectors: PathSelector[] = [tree("/home/user/.pi/agent/extensions")];

  // act
  const covered = coveredProtectedSelectors(grant, protectedSelectors);

  // assert
  assert.deepEqual(covered, []);
});
