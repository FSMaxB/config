import assert from "node:assert/strict";
import { test } from "node:test";
import { fixSource, lintSource } from "./lint-source.ts";

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

test("fixes a function above its caller by moving it below", () => {
  // arrange
  const source = [
    "function helper(): number { return 1; }",
    "",
    "export function run(): number { return helper(); }",
    "",
  ].join("\n");
  const expected = [
    "export function run(): number { return helper(); }",
    "",
    "function helper(): number { return 1; }",
    "",
  ].join("\n");

  // act
  const fixed = fixSource("step-down", source);

  // assert
  assert.equal(fixed, expected);
});

test("moves the comments above a helper along with it", () => {
  // arrange
  const source = [
    "/** Doc. */",
    "// Note.",
    "function helper(): number { return 1; }",
    "",
    "export function run(): number { return helper(); }",
    "",
  ].join("\n");
  const expected = [
    "export function run(): number { return helper(); }",
    "",
    "/** Doc. */",
    "// Note.",
    "function helper(): number { return 1; }",
    "",
  ].join("\n");

  // act
  const fixed = fixSource("step-down", source);

  // assert
  assert.equal(fixed, expected);
});

test("keeps single newlines between statements", () => {
  // arrange
  const source = [
    "const first = 1;",
    "function helper(): number { return 1; }",
    "export function run(): number { return helper() + first; }",
    "",
  ].join("\n");
  const expected = [
    "const first = 1;",
    "export function run(): number { return helper() + first; }",
    "function helper(): number { return 1; }",
    "",
  ].join("\n");

  // act
  const fixed = fixSource("step-down", source);

  // assert
  assert.equal(fixed, expected);
});

test("moves a trailing comment on the helper's last line along with it", () => {
  // arrange
  const source = [
    "function helper(): number { return 1; } // Trailing.",
    "",
    "export function run(): number { return helper(); }",
    "",
  ].join("\n");
  const expected = [
    "export function run(): number { return helper(); }",
    "",
    "function helper(): number { return 1; } // Trailing.",
    "",
  ].join("\n");

  // act
  const fixed = fixSource("step-down", source);

  // assert
  assert.equal(fixed, expected);
});

test("fixes an interface above the function that uses it", () => {
  // arrange
  const source = [
    "interface Options { readonly name: string }",
    "",
    "export function run(options: Options): string { return options.name; }",
    "",
  ].join("\n");
  const expected = [
    "export function run(options: Options): string { return options.name; }",
    "",
    "interface Options { readonly name: string }",
    "",
  ].join("\n");

  // act
  const fixed = fixSource("step-down", source);

  // assert
  assert.equal(fixed, expected);
});

test("keeps two helpers of one function in their relative order", () => {
  // arrange
  const source = [
    "function first(): number { return 1; }",
    "",
    "function second(): number { return 2; }",
    "",
    "export function run(): number { return first() + second(); }",
    "",
  ].join("\n");
  const expected = [
    "export function run(): number { return first() + second(); }",
    "",
    "function first(): number { return 1; }",
    "",
    "function second(): number { return 2; }",
    "",
  ].join("\n");

  // act
  const fixed = fixSource("step-down", source);

  // assert
  assert.equal(fixed, expected);
});

test("orders a chain of helpers in one fix", () => {
  // arrange
  const source = [
    "function third(): number { return 3; }",
    "",
    "function second(): number { return third(); }",
    "",
    "export function first(): number { return second(); }",
    "",
  ].join("\n");
  const expected = [
    "export function first(): number { return second(); }",
    "",
    "function second(): number { return third(); }",
    "",
    "function third(): number { return 3; }",
    "",
  ].join("\n");

  // act
  const fixed = fixSource("step-down", source);

  // assert
  assert.equal(fixed, expected);
});

test("moves a helper below the top-level statement that uses it", () => {
  // arrange
  const source = [
    "function helper(): number { return 1; }",
    "",
    "export const value = helper();",
    "",
  ].join("\n");
  const expected = [
    "export const value = helper();",
    "",
    "function helper(): number { return 1; }",
    "",
  ].join("\n");

  // act
  const fixed = fixSource("step-down", source);

  // assert
  assert.equal(fixed, expected);
});

test("leaves mutually recursive functions alone", () => {
  // arrange
  const source = [
    "export function isEven(value: number): boolean { return value === 0 || isOdd(value - 1); }",
    "function isOdd(value: number): boolean { return value !== 0 && isEven(value - 1); }",
    "",
  ].join("\n");

  // act
  const fixed = fixSource("step-down", source);

  // assert
  assert.equal(fixed, source);
});

test("reports a class above its user without moving it", () => {
  // arrange
  const source = [
    "class Box { value = 1; }",
    "",
    "export function run(): number { return new Box().value; }",
    "",
  ].join("\n");
  const expected = ["'Box' is used by 'run' below it. Move it below its users (step-down rule)."];

  // act
  const messages = lintSource("step-down", source);
  const fixed = fixSource("step-down", source);

  // assert
  assert.deepEqual(messages, expected);
  assert.equal(fixed, source);
});

test("reports an overloaded function above its caller without moving it", () => {
  // arrange
  const source = [
    "function pick(value: string): string;",
    "function pick(value: number): number;",
    "function pick(value: string | number): string | number { return value; }",
    "",
    'export function run(): string { return pick("a"); }',
    "",
  ].join("\n");
  const expected = ["'pick' is used by 'run' below it. Move it below its users (step-down rule)."];

  // act
  const messages = lintSource("step-down", source);
  const fixed = fixSource("step-down", source);

  // assert
  assert.deepEqual(messages, expected);
  assert.equal(fixed, source);
});

test("keeps a file header above the first statement", () => {
  // arrange
  const source = [
    "// Header.",
    "",
    "function helper(): number { return 1; }",
    "",
    "export function run(): number { return helper(); }",
    "",
  ].join("\n");
  const expected = [
    "// Header.",
    "",
    "export function run(): number { return helper(); }",
    "",
    "function helper(): number { return 1; }",
    "",
  ].join("\n");

  // act
  const fixed = fixSource("step-down", source);

  // assert
  assert.equal(fixed, expected);
});
