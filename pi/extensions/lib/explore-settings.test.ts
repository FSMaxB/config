import assert from "node:assert/strict";
import test from "node:test";
import { isExploreAlwaysOn } from "./explore-settings.ts";

test("alwaysOn true starts new sessions in explore mode", () => {
  // arrange
  const settings = { exploreMode: { alwaysOn: true } };

  // act
  const result = isExploreAlwaysOn(settings);

  // assert
  assert.equal(result, true);
});

test("missing exploreMode block keeps explore mode off by default", () => {
  // arrange
  const settings = { theme: "gruvbox-dark" };

  // act
  const result = isExploreAlwaysOn(settings);

  // assert
  assert.equal(result, false);
});

test("a non-boolean alwaysOn keeps explore mode off by default", () => {
  // arrange
  const settings = { exploreMode: { alwaysOn: "yes" } };

  // act
  const result = isExploreAlwaysOn(settings);

  // assert
  assert.equal(result, false);
});
