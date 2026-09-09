import assert from "node:assert/strict";
import test from "node:test";
import {
  applyOps,
  parsePatch,
  recordSnapshot,
  remapOps,
  renderNumbered,
  snapshotOf,
  tagOf,
} from "./hashline.ts";

test("tagOf is stable for the same content and differs after a one-character change", () => {
  // arrange
  const content = "hello world\n";
  const changed = "hello worlds\n";

  // act
  const tagA = tagOf(content);
  const tagB = tagOf(content);
  const tagC = tagOf(changed);

  // assert
  assert.equal(tagA, tagB);
  assert.notEqual(tagA, tagC);
  assert.match(tagA, /^[0-9A-F]{4}$/);
});

test("snapshotOf reports line count, trailing newline and line ending", () => {
  // act
  const withNewline = snapshotOf("a\nb\n");
  const withoutNewline = snapshotOf("a\nb");
  const crlf = snapshotOf("a\r\nb\r\n");
  const empty = snapshotOf("");

  // assert
  assert.deepEqual(withNewline.lines, ["a", "b"]);
  assert.equal(withNewline.trailingNewline, true);
  assert.equal(withNewline.lineEnding, "\n");

  assert.deepEqual(withoutNewline.lines, ["a", "b"]);
  assert.equal(withoutNewline.trailingNewline, false);

  assert.deepEqual(crlf.lines, ["a", "b"]);
  assert.equal(crlf.trailingNewline, true);
  assert.equal(crlf.lineEnding, "\r\n");

  assert.deepEqual(empty.lines, []);
  assert.equal(empty.trailingNewline, false);
});

test("parsePatch accepts all four ops, $, multi-op patches and blank body rows", () => {
  // arrange
  const tag = tagOf("a\nb\nc\nd\n");
  const input = [
    `[file.ts#${tag}]`,
    "PUT 2.=2:",
    "+B",
    "+",
    "CUT 4.=4",
    "PUT <1:",
    "+header",
    "PUT >$:",
    "+footer",
  ].join("\n");

  // act
  const patch = parsePatch(input);

  // assert
  assert.equal(patch.path, "file.ts");
  assert.equal(patch.tag, tag);
  assert.deepEqual(patch.ops, [
    { kind: "replace", from: 2, to: 2, body: ["B", ""] },
    { kind: "delete", from: 4, to: 4 },
    { kind: "insert", at: 1, side: "before", body: ["header"] },
    { kind: "insert", at: Infinity, side: "after", body: ["footer"] },
  ]);
});

test("parsePatch rejects a missing header", () => {
  assert.throws(() => parsePatch("PUT 1.=1:\n+x"), /must start with \[path#TAG\]/);
});

test("parsePatch rejects a malformed tag", () => {
  assert.throws(() => parsePatch("[file.ts#zz]\nPUT 1.=1:\n+x"), /must start with \[path#TAG\]/);
});

test("parsePatch rejects -old rows", () => {
  const tag = tagOf("a\n");
  assert.throws(
    () => parsePatch(`[file.ts#${tag}]\nPUT 1.=1:\n-a\n+b`),
    /bodies list only the final content/,
  );
});

test("parsePatch rejects a body row before any op", () => {
  const tag = tagOf("a\n");
  assert.throws(
    () => parsePatch(`[file.ts#${tag}]\n+b`),
    /'\+' body row with no preceding PUT op/,
  );
});

test("parsePatch rejects an unknown op", () => {
  const tag = tagOf("a\n");
  assert.throws(
    () => parsePatch(`[file.ts#${tag}]\nMOVE 1.=1:`),
    /not a recognized op/,
  );
});

test("parsePatch rejects from > to", () => {
  const tag = tagOf("a\nb\n");
  assert.throws(
    () => parsePatch(`[file.ts#${tag}]\nPUT 2.=1:\n+x`),
    /starts after it ends/,
  );
});

test("parsePatch rejects an out-of-range line number", () => {
  const tag = tagOf("a\n");
  assert.throws(
    () => parsePatch(`[file.ts#${tag}]\nPUT 0.=0:\n+x`),
    /line numbers start at 1/,
  );
});

test("parsePatch rejects overlapping ops", () => {
  const tag = tagOf("a\nb\nc\n");
  assert.throws(
    () => parsePatch(`[file.ts#${tag}]\nPUT 1.=2:\n+x\nCUT 2.=3`),
    /must not overlap/,
  );
});

test("applyOps replaces a range mid-file", () => {
  // arrange
  const snapshot = snapshotOf("a\nb\nc\nd\n");

  // act
  const { content, changed } = applyOps(snapshot, [
    { kind: "replace", from: 2, to: 3, body: ["B", "C"] },
  ]);

  // assert
  assert.equal(content, "a\nB\nC\nd\n");
  assert.deepEqual(changed, [{ from: 2, to: 3 }]);
});

test("applyOps replaces the whole file", () => {
  const snapshot = snapshotOf("a\nb\n");
  const { content } = applyOps(snapshot, [
    { kind: "replace", from: 1, to: Infinity, body: ["x"] },
  ]);
  assert.equal(content, "x\n");
});

test("applyOps inserts before line 1 and after $", () => {
  const snapshot = snapshotOf("a\nb\n");

  const before = applyOps(snapshot, [{ kind: "insert", at: 1, side: "before", body: ["z"] }]);
  assert.equal(before.content, "z\na\nb\n");
  assert.deepEqual(before.changed, [{ from: 1, to: 1 }]);

  const after = applyOps(snapshot, [{ kind: "insert", at: Infinity, side: "after", body: ["z"] }]);
  assert.equal(after.content, "a\nb\nz\n");
  assert.deepEqual(after.changed, [{ from: 3, to: 3 }]);
});

test("applyOps deletes a range", () => {
  const snapshot = snapshotOf("a\nb\nc\nd\n");
  const { content, changed } = applyOps(snapshot, [{ kind: "delete", from: 2, to: 3 }]);
  assert.equal(content, "a\nd\n");
  assert.deepEqual(changed, [{ from: 2, to: 1 }]);
});

test("applyOps applies two ops in one patch addressing the original numbering", () => {
  // arrange: both ops name lines of the *original* 4-line file, not renumbered mid-way
  const snapshot = snapshotOf("a\nb\nc\nd\n");

  // act
  const { content, changed } = applyOps(snapshot, [
    { kind: "replace", from: 1, to: 1, body: ["A", "A2"] },
    { kind: "delete", from: 4, to: 4 },
  ]);

  // assert
  assert.equal(content, "A\nA2\nb\nc\n");
  assert.deepEqual(changed, [
    { from: 1, to: 2 },
    { from: 5, to: 4 },
  ]);
});

test("applyOps output re-snapshotted has the tag the edit result would report", () => {
  const snapshot = snapshotOf("a\nb\n");
  const { content } = applyOps(snapshot, [{ kind: "replace", from: 1, to: 1, body: ["A"] }]);
  const recorded = recordSnapshot("/tmp/hashline-roundtrip.ts", content);
  assert.equal(recorded.tag, tagOf(content));
});

test("remapOps shifts an anchor when unrelated lines were inserted above it", () => {
  // arrange
  const from = snapshotOf("a\nb\nc\n");
  const to = snapshotOf("x\na\nb\nc\n");

  // act
  const [remapped] = remapOps([{ kind: "replace", from: 2, to: 2, body: ["B"] }], from, to);

  // assert
  assert.deepEqual(remapped, { kind: "replace", from: 3, to: 3, body: ["B"] });
});

test("remapOps rejects when the anchor block itself changed", () => {
  const from = snapshotOf("a\nb\nc\n");
  const to = snapshotOf("a\nX\nc\n");
  assert.throws(
    () => remapOps([{ kind: "delete", from: 2, to: 2 }], from, to),
    /stale/,
  );
});

test("remapOps rejects when the anchor block occurs twice", () => {
  const from = snapshotOf("a\nb\nc\n");
  const to = snapshotOf("b\na\nb\nc\n");
  assert.throws(
    () => remapOps([{ kind: "delete", from: 2, to: 2 }], from, to),
    /stale/,
  );
});

test("renderNumbered numbers from an offset and renders an empty line as N:", () => {
  const rendered = renderNumbered(["a", "", "c"], 10);
  assert.equal(rendered, "10:a\n11:\n12:c");
});
