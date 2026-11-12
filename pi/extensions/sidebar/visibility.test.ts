import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultVisibility, sessionVisibility, VISIBILITY_ENTRY, Visibility } from "./visibility.ts";

const toggle = (enabled: boolean) => ({ type: "custom", customType: VISIBILITY_ENTRY, data: { enabled } });

test("sessionVisibility returns the latest toggle", () => {
  // arrange
  const entries = [toggle(false), { type: "message" }, toggle(true), toggle(false)];

  // act
  const visibility = sessionVisibility(entries);

  // assert
  assert.equal(visibility, Visibility.Off);
});

test("sessionVisibility returns undefined without a toggle", () => {
  // arrange
  const entries = [{ type: "message" }];

  // act
  const visibility = sessionVisibility(entries);

  // assert
  assert.equal(visibility, undefined);
});

test("sessionVisibility ignores other custom types and malformed data", () => {
  // arrange
  const entries = [
    { type: "custom", customType: "loaded-skill", data: { enabled: false } },
    { type: "custom", customType: VISIBILITY_ENTRY, data: { enabled: "yes" } },
    { type: "custom", customType: VISIBILITY_ENTRY },
  ];

  // act
  const visibility = sessionVisibility(entries);

  // assert
  assert.equal(visibility, undefined);
});

test("defaultVisibility is on unless sidebar.enabled is false", () => {
  // arrange
  const cases: [object, Visibility][] = [
    [{}, Visibility.On],
    [{ sidebar: { enabled: false } }, Visibility.Off],
    [{ sidebar: { enabled: true } }, Visibility.On],
    [{ sidebar: { enabled: "no" } }, Visibility.On],
    [{ sidebar: null }, Visibility.On],
  ];

  // act
  const results = cases.map(([settings]) => defaultVisibility(settings));

  // assert
  assert.deepEqual(
    results,
    cases.map(([, expected]) => expected),
  );
});
