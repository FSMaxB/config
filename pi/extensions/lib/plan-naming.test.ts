import assert from "node:assert/strict";
import { basename, dirname } from "node:path";
import test from "node:test";
import { planPathIn } from "./plan-naming.ts";

test("a slug with path traversal stays inside the plans directory", () => {
  // arrange
  const directory = "/plans/project";

  // act
  const path = planPathIn(directory, "../../etc/passwd");

  // assert
  assert.equal(dirname(path), directory);
  assert.match(basename(path), /^\d{8}-\d{4}-etc-passwd\.md$/);
});

test("an absolute path as slug stays inside the plans directory", () => {
  // arrange
  const directory = "/plans/project";

  // act
  const path = planPathIn(directory, "/etc/passwd");

  // assert
  assert.equal(dirname(path), directory);
  assert.match(basename(path), /^\d{8}-\d{4}-etc-passwd\.md$/);
});

test("a slug without usable characters falls back to plan", () => {
  // arrange
  const directory = "/plans/project";

  // act
  const path = planPathIn(directory, "../..");

  // assert
  assert.equal(dirname(path), directory);
  assert.match(basename(path), /^\d{8}-\d{4}-plan\.md$/);
});
