import assert from "node:assert/strict";
import test from "node:test";
import { isAlwaysOn } from "./settings.ts";

test("alwaysOn true turns the mode on by default", () => {
  // arrange
  const settings = { iHaveAdhd: { alwaysOn: true } };

  // act
  const result = isAlwaysOn(settings);

  // assert
  assert.equal(result, true);
});

test("missing iHaveAdhd block keeps the mode off by default", () => {
  // arrange
  const settings = { theme: "gruvbox-dark" };

  // act
  const result = isAlwaysOn(settings);

  // assert
  assert.equal(result, false);
});

test("a non-boolean alwaysOn keeps the mode off by default", () => {
  // arrange
  const settings = { iHaveAdhd: { alwaysOn: "yes" } };

  // act
  const result = isAlwaysOn(settings);

  // assert
  assert.equal(result, false);
});
