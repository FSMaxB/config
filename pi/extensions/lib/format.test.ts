import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { shortenPath } from "./format.ts";

test("a path inside the home directory is shortened", () => {
  // arrange
  const path = join(homedir(), "x");

  // act
  const shortened = shortenPath(path);

  // assert
  assert.equal(shortened, "~/x");
});

test("the home directory itself is shortened to ~", () => {
  // act
  const shortened = shortenPath(homedir());

  // assert
  assert.equal(shortened, "~");
});

test("a path that only shares a home prefix is unchanged", () => {
  // arrange
  const path = `${homedir()}im/x`;

  // act
  const shortened = shortenPath(path);

  // assert
  assert.equal(shortened, path);
});
