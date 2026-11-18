import assert from "node:assert/strict";
import { test } from "node:test";
import { lintSource } from "./lint-source.ts";

test("accepts helpers below their callers", () => {
  // arrange
  const source = `
    export function run(): number { return helper(); }
    function helper(): number { return 1; }
  `;

  // act
  const messages = lintSource("step-down", source);

  // assert
  assert.deepEqual(messages, []);
});

test("reports a function above its caller", () => {
  // arrange
  const source = `
    function helper(): number { return 1; }
    export function run(): number { return helper(); }
  `;
  const expected = ["'helper' is used by 'run' below it. Move it below its users (step-down rule)."];

  // act
  const messages = lintSource("step-down", source);

  // assert
  assert.deepEqual(messages, expected);
});

test("reports a type above the function that uses it", () => {
  // arrange
  const source = `
    interface Options { readonly name: string }
    export function run(options: Options): string { return options.name; }
  `;
  const expected = ["'Options' is used by 'run' below it. Move it below its users (step-down rule)."];

  // act
  const messages = lintSource("step-down", source);

  // assert
  assert.deepEqual(messages, expected);
});

test("reports a helper above a top-level statement that uses it", () => {
  // arrange
  const source = `
    function helper(): number { return 1; }
    export const value = helper();
  `;
  const expected = ["'helper' is used by a top-level statement below it. Move it below its users (step-down rule)."];

  // act
  const messages = lintSource("step-down", source);

  // assert
  assert.deepEqual(messages, expected);
});

test("accepts mutually recursive functions in either order", () => {
  // arrange
  const source = `
    function isEven(value: number): boolean { return value === 0 || isOdd(value - 1); }
    function isOdd(value: number): boolean { return value !== 0 && isEven(value - 1); }
  `;

  // act
  const messages = lintSource("step-down", source);

  // assert
  assert.deepEqual(messages, []);
});

test("does not count re-exports as users", () => {
  // arrange
  const source = `
    function helper(): number { return 1; }
    export { helper };
    export default helper;
  `;

  // act
  const messages = lintSource("step-down", source);

  // assert
  assert.deepEqual(messages, []);
});
