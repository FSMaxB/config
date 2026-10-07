import assert from "node:assert/strict";
import test from "node:test";
import { dropDuplicateNames } from "./agent-names.ts";

test("a later file with a duplicate name is skipped and named", () => {
  // arrange
  const entries = [
    { file: "b.md", agent: { name: "explore" } },
    { file: "a.md", agent: { name: "explore" } },
  ];

  // act
  const { agents, skipped } = dropDuplicateNames(entries);

  // assert
  assert.deepEqual(agents, [{ name: "explore" }]);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0], /b\.md/);
  assert.match(skipped[0], /a\.md/);
});

test("distinct names are all kept", () => {
  // arrange
  const entries = [
    { file: "b.md", agent: { name: "explore" } },
    { file: "a.md", agent: { name: "review" } },
  ];

  // act
  const { agents, skipped } = dropDuplicateNames(entries);

  // assert
  assert.deepEqual(agents, [{ name: "review" }, { name: "explore" }]);
  assert.deepEqual(skipped, []);
});
