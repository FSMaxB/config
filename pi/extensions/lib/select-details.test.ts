import assert from "node:assert/strict";
import { test } from "node:test";
import { detailsHeight, detailsLines } from "./select-details.ts";
import type { TextMeasure } from "./select-details.ts";

const measure: TextMeasure = {
  width: (text) => text.length,
  wrap: (text, width) => text.match(new RegExp(`.{1,${width}}`, "g")) ?? [""],
};
// Rows fit 10 columns, the pane wraps at 12.
const width = 14;

test("detailsLines is empty when every option fits its row", () => {
  // arrange
  const options = ["short", "tenletters"];

  // act
  const lines = detailsLines(options, 0, width, measure);

  // assert
  assert.deepEqual(lines, []);
});

test("detailsLines wraps the highlighted option when it is cut", () => {
  // arrange
  const options = ["a".repeat(20), "b"];

  // act
  const lines = detailsLines(options, 0, width, measure);

  // assert
  assert.deepEqual(lines, ["a".repeat(12), "a".repeat(8)]);
});

test("detailsLines pads a short highlighted option to the tallest cut option", () => {
  // arrange
  const options = ["a".repeat(20), "b"];

  // act
  const lines = detailsLines(options, 1, width, measure);

  // assert
  assert.deepEqual(lines, ["b", ""]);
});

test("detailsHeight is the line count of the tallest cut option", () => {
  // arrange
  const options = ["a".repeat(20), "c".repeat(30), "d"];

  // act
  const height = detailsHeight(options, width, measure);

  // assert
  assert.equal(height, 3);
});
