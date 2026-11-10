import assert from "node:assert/strict";
import test from "node:test";
import {
  GrepCollector,
  GrepRowKind,
  LineOutcome,
  parseRipgrepEvent,
  type RipgrepEvent,
} from "./grep-collector.ts";

const match = (lineNumber: number, text: string, filePath = "a.ts"): RipgrepEvent => ({
  type: "match",
  data: { path: { text: filePath }, line_number: lineNumber, lines: { text: `${text}\n` } },
});

const contextLine = (lineNumber: number, text: string, filePath = "a.ts"): RipgrepEvent => ({
  type: "context",
  data: { path: { text: filePath }, line_number: lineNumber, lines: { text: `${text}\n` } },
});

test("exactly the limit of matches does not report the limit as reached", () => {
  // arrange
  const collector = new GrepCollector(2, 0);

  // act
  const outcomes = [collector.accept(match(1, "one")), collector.accept(match(5, "two"))];

  // assert
  assert.deepEqual(outcomes, [LineOutcome.Continue, LineOutcome.Continue]);
  assert.equal(collector.rows.length, 2);
  assert.equal(collector.matchCount, 2);
  assert.equal(collector.limitReached, false);
});

test("a match past the limit stops the search and is not kept", () => {
  // arrange
  const collector = new GrepCollector(2, 0);
  collector.accept(match(1, "one"));
  collector.accept(match(2, "two"));

  // act
  const outcome = collector.accept(match(1, "three", "b.ts"));

  // assert
  assert.equal(outcome, LineOutcome.Stop);
  assert.equal(collector.limitReached, true);
  assert.deepEqual(
    collector.rows.map((row) => row.text),
    ["one", "two"],
  );
});

test("a match inside the trailing context of the last allowed match is shown as context", () => {
  // arrange
  const collector = new GrepCollector(1, 2);

  // act
  const outcomes = [
    collector.accept(match(1, "one")),
    collector.accept(contextLine(2, "two")),
    collector.accept(match(3, "three")),
  ];

  // assert
  assert.deepEqual(outcomes, [LineOutcome.Continue, LineOutcome.Continue, LineOutcome.Stop]);
  assert.deepEqual(
    collector.rows.map((row) => [row.lineNumber, row.kind]),
    [
      [1, GrepRowKind.Match],
      [2, GrepRowKind.Context],
      [3, GrepRowKind.Context],
    ],
  );
  assert.equal(collector.limitReached, true);
});

test("context lines before the first match are kept in order", () => {
  // arrange
  const collector = new GrepCollector(5, 2);

  // act
  collector.accept(contextLine(1, "one"));
  collector.accept(contextLine(2, "two"));
  collector.accept(match(3, "three"));

  // assert
  assert.deepEqual(
    collector.rows.map((row) => row.text),
    ["one", "two", "three"],
  );
  assert.equal(collector.matchCount, 1);
});

test("events other than match and context, and unparsable lines, are ignored", () => {
  // arrange
  const collector = new GrepCollector(5, 0);

  // act
  const outcomes = [
    collector.accept({ type: "begin", data: { path: { text: "a.ts" } } }),
    collector.accept({ type: "end" }),
    collector.accept({ type: "summary" }),
  ];

  // assert
  assert.deepEqual(outcomes, [LineOutcome.Continue, LineOutcome.Continue, LineOutcome.Continue]);
  assert.equal(collector.rows.length, 0);
  assert.equal(parseRipgrepEvent("not json"), undefined);
});

test("a path reported as base64 bytes is decoded", () => {
  // arrange
  const collector = new GrepCollector(5, 0);
  const event: RipgrepEvent = {
    type: "match",
    data: {
      path: { bytes: Buffer.from("ä.ts").toString("base64") },
      line_number: 1,
      lines: { text: "x\n" },
    },
  };

  // act
  collector.accept(event);

  // assert
  assert.equal(collector.rows[0]?.filePath, "ä.ts");
});

test("a lone carriage return inside a line is kept while the line terminator is stripped", () => {
  // arrange
  const collector = new GrepCollector(5, 0);

  // act
  collector.accept(match(1, "a\rb"));
  collector.accept({
    type: "match",
    data: { path: { text: "a.ts" }, line_number: 2, lines: { text: "a\r\n" } },
  });

  // assert
  assert.deepEqual(
    collector.rows.map((row) => row.text),
    ["a\rb", "a"],
  );
});
