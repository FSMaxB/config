import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatDuration, shortenPath } from "./format.ts";

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

test("durations under a minute show tenths of a second", () => {
  // arrange
  const milliseconds = 4_250;

  // act
  const formatted = formatDuration(milliseconds);

  // assert
  assert.equal(formatted, "4.3s");
});

test("durations under an hour show minutes and whole seconds", () => {
  // arrange
  const milliseconds = 125_900;

  // act
  const formatted = formatDuration(milliseconds);

  // assert
  assert.equal(formatted, "2m 5s");
});

test("durations of an hour or more show hours and minutes", () => {
  // arrange
  const milliseconds = 3_900_000;

  // act
  const formatted = formatDuration(milliseconds);

  // assert
  assert.equal(formatted, "1h 5m");
});
