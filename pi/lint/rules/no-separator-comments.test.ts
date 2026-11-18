import assert from "node:assert/strict";
import { test } from "node:test";
import { lintSource } from "./lint-source.ts";

test("reports separator comments", () => {
  // arrange
  const source = [
    "// ------------------------------",
    "// --- Setup ---",
    "/* ****************************** */",
    "export const value = 1;",
  ].join("\n");
  const separators = 3;

  // act
  const messages = lintSource("no-separator-comments", source);

  // assert
  assert.equal(messages.length, separators);
});

test("accepts ordinary comments and doc comments", () => {
  // arrange
  const source = [
    "/**",
    " * Explains why the value is 1.",
    " */",
    "// The cache holds 3 entries --- enough for one turn.",
    "// Matches pi/extensions/**",
    "// Pass --force to skip the check.",
    "export const value = 1;",
  ].join("\n");

  // act
  const messages = lintSource("no-separator-comments", source);

  // assert
  assert.deepEqual(messages, []);
});
