import assert from "node:assert/strict";
import test from "node:test";
import { formatJjAnnotate } from "./jj-annotate.ts";

const row = (changeId: string, description: string, lineNumber: number, content: string) =>
  [changeId, "Max Bruckner", "2026-06-23", description, String(lineNumber), content].join("\t");

test("legend lists each change once in order of first appearance", () => {
  // arrange
  const output = [row("aaaaaaaa", "first", 1, "one"), row("bbbbbbbb", "second", 2, "two"), row("aaaaaaaa", "first", 3, "three")].join("\n") + "\n";

  // act
  const text = formatJjAnnotate(output, undefined, undefined);

  // assert
  assert.equal(
    text,
    [
      "aaaaaaaa  Max Bruckner 2026-06-23  first",
      "bbbbbbbb  Max Bruckner 2026-06-23  second",
      "",
      "aaaaaaaa    1: one",
      "bbbbbbbb    2: two",
      "aaaaaaaa    3: three",
    ].join("\n"),
  );
});

test("pagination limits both rows and legend to the page", () => {
  // arrange
  const output = [row("aaaaaaaa", "first", 1, "one"), row("bbbbbbbb", "second", 2, "two"), row("cccccccc", "third", 3, "three")].join("\n") + "\n";

  // act
  const text = formatJjAnnotate(output, 2, 1);

  // assert
  assert.equal(
    text,
    ["bbbbbbbb  Max Bruckner 2026-06-23  second", "", "[lines 2-2 of 3]", "bbbbbbbb    2: two"].join("\n"),
  );
});

test("content keeps its tabs and indentation", () => {
  // arrange
  const output = row("aaaaaaaa", "first", 1, "\tkey:\tvalue") + "\n";

  // act
  const text = formatJjAnnotate(output, undefined, undefined);

  // assert
  assert.ok(text.endsWith("aaaaaaaa    1: \tkey:\tvalue"), text);
});

test("empty description is spelled out in the legend", () => {
  // arrange
  const output = row("aaaaaaaa", "", 1, "x") + "\n";

  // act
  const text = formatJjAnnotate(output, undefined, undefined);

  // assert
  assert.ok(text.startsWith("aaaaaaaa  Max Bruckner 2026-06-23  (no description set)"), text);
});

test("empty output stays empty so the caller reports no output", () => {
  // arrange / act
  const text = formatJjAnnotate("", undefined, undefined);

  // assert
  assert.equal(text, "");
});

test("offset past the end reports the file length", () => {
  // arrange
  const output = row("aaaaaaaa", "first", 1, "one") + "\n";

  // act
  const text = formatJjAnnotate(output, 5, undefined);

  // assert
  assert.equal(text, "(no lines: offset 5 starts past the end of this 1-line file)");
});
