import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { footerTargetAt, thinkingDisplay } from "./regions.ts";
import type { FooterSnapshot, ModelDisplay, TextMeasure } from "./regions.ts";

// Fixture characters are single UTF-16 units that take one column.
// eslint-disable-next-line no-control-regex -- terminal sequences start with the escape character.
const ANSI_SEQUENCE = /\x1b\[[0-9;]*m/g;
const measure: TextMeasure = {
  strip: (text) => text.replaceAll(ANSI_SEQUENCE, ""),
  width: (text) => text.replaceAll(ANSI_SEQUENCE, "").length,
};

const MODEL: ModelDisplay = { provider: "pi-claude", id: "claude-opus-5-5", thinking: "high" };
const STATS_ROW = 1;
const STATUS_ROW = 2;

describe("footerTargetAt on the stats row", () => {
  it("targets the model on its id and on its provider prefix", () => {
    // arrange
    const view = snapshot({});
    const line = view.lines[STATS_ROW] ?? "";
    const onId = columnOf(line, "claude-opus-5-5") + 3;
    const onPrefix = columnOf(line, "(pi-claude)") + 2;
    const expected = { kind: "model" };

    // act
    const clickedId = footerTargetAt(view, onId, STATS_ROW, measure);
    const clickedPrefix = footerTargetAt(view, onPrefix, STATS_ROW, measure);

    // assert
    assert.deepEqual(clickedId, expected);
    assert.deepEqual(clickedPrefix, expected);
  });

  it("targets the thinking level on its separator and its name", () => {
    // arrange
    const view = snapshot({});
    const line = view.lines[STATS_ROW] ?? "";
    const onLevel = columnOf(line, "high") + 1;
    const onSeparator = columnOf(line, "•");
    const expected = { kind: "thinking" };

    // act
    const clickedLevel = footerTargetAt(view, onLevel, STATS_ROW, measure);
    const clickedSeparator = footerTargetAt(view, onSeparator, STATS_ROW, measure);

    // assert
    assert.deepEqual(clickedLevel, expected);
    assert.deepEqual(clickedSeparator, expected);
  });

  it("targets the thinking level when it reads thinking off", () => {
    // arrange
    const view = snapshot({
      lines: ["cwd", statsLine("claude-opus-5-5 • thinking off"), ""],
      model: { ...MODEL, thinking: thinkingDisplay("off") },
    });
    const line = view.lines[STATS_ROW] ?? "";
    const onOff = columnOf(line, "off") + 1;
    const expected = { kind: "thinking" };

    // act
    const target = footerTargetAt(view, onOff, STATS_ROW, measure);

    // assert
    assert.deepEqual(target, expected);
  });

  it("ignores the token stats and the padding", () => {
    // arrange
    const view = snapshot({});
    const line = view.lines[STATS_ROW] ?? "";
    const onStats = columnOf(line, "$0.012");
    const onPadding = columnOf(line, "(pi-claude)") - 2;

    // act
    const clickedStats = footerTargetAt(view, onStats, STATS_ROW, measure);
    const clickedPadding = footerTargetAt(view, onPadding, STATS_ROW, measure);

    // assert
    assert.equal(clickedStats, undefined);
    assert.equal(clickedPadding, undefined);
  });

  it("still finds the model id when the right side is cut before the level", () => {
    // arrange
    const view = snapshot({ lines: ["cwd", statsLine("claude-opus-5-5 •"), ""] });
    const line = view.lines[STATS_ROW] ?? "";
    const onId = columnOf(line, "claude-opus-5-5") + 1;
    const onCutSeparator = columnOf(line, "•");
    const expected = { kind: "model" };

    // act
    const clickedId = footerTargetAt(view, onId, STATS_ROW, measure);
    const clickedSeparator = footerTargetAt(view, onCutSeparator, STATS_ROW, measure);

    // assert
    assert.deepEqual(clickedId, expected);
    assert.equal(clickedSeparator, undefined);
  });

  it("ignores the routed model after the arrow", () => {
    // arrange
    const view = snapshot({ lines: ["cwd", statsLine("claude-opus-5-5 • high → other-model • low"), ""] });
    const line = view.lines[STATS_ROW] ?? "";
    const onRouted = columnOf(line, "other-model") + 2;

    // act
    const target = footerTargetAt(view, onRouted, STATS_ROW, measure);

    // assert
    assert.equal(target, undefined);
  });

  it("ignores every click when no model is selected", () => {
    // arrange
    const view = snapshot({ model: undefined });
    const line = view.lines[STATS_ROW] ?? "";
    const onId = columnOf(line, "claude-opus-5-5");

    // act
    const target = footerTargetAt(view, onId, STATS_ROW, measure);

    // assert
    assert.equal(target, undefined);
  });
});

describe("footerTargetAt on the status row", () => {
  it("walks the statuses in key order, whatever their insertion order", () => {
    // arrange
    const statuses = new Map([
      ["pause", "⏸ paused"],
      ["agent-mode", "execute"],
      ["i-have-adhd", "● ADHD ON"],
    ]);
    const view = snapshot({ statuses, lines: ["cwd", "stats", "execute ● ADHD ON ⏸ paused"] });
    const insideSecond = "execute ".length + 2;
    const expected = { kind: "status", key: "i-have-adhd" };

    // act
    const target = footerTargetAt(view, insideSecond, STATUS_ROW, measure);

    // assert
    assert.deepEqual(target, expected);
  });

  it("ignores the space between two statuses", () => {
    // arrange
    const statuses = new Map([
      ["agent-mode", "execute"],
      ["i-have-adhd", "● ADHD ON"],
    ]);
    const view = snapshot({ statuses, lines: ["cwd", "stats", "execute ● ADHD ON"] });
    const onSeparator = "execute".length;

    // act
    const target = footerTargetAt(view, onSeparator, STATUS_ROW, measure);

    // assert
    assert.equal(target, undefined);
  });

  it("shifts later statuses by the sanitized width of an earlier one", () => {
    // arrange
    const statuses = new Map([
      ["a", "a\n  b"],
      ["b", "target"],
    ]);
    const view = snapshot({ statuses, lines: ["cwd", "stats", "a b target"] });
    const onTarget = "a b ".length + 1;
    const expected = { kind: "status", key: "b" };

    // act
    const target = footerTargetAt(view, onTarget, STATUS_ROW, measure);

    // assert
    assert.deepEqual(target, expected);
  });

  it("ignores clicks past the last status", () => {
    // arrange
    const statuses = new Map([["agent-mode", "execute"]]);
    const view = snapshot({ statuses, lines: ["cwd", "stats", "execute"] });

    // act
    const target = footerTargetAt(view, "execute".length + 5, STATUS_ROW, measure);

    // assert
    assert.equal(target, undefined);
  });
});

describe("footerTargetAt on other rows", () => {
  it("ignores the working directory row and rows below the footer", () => {
    // arrange
    const view = snapshot({});

    // act
    const onCwd = footerTargetAt(view, 1, 0, measure);
    const below = footerTargetAt(view, 1, 3, measure);

    // assert
    assert.equal(onCwd, undefined);
    assert.equal(below, undefined);
  });
});

describe("thinkingDisplay", () => {
  it("spells out the off level the way the footer does", () => {
    // arrange
    const expected = "thinking off";

    // act
    const display = thinkingDisplay("off");

    // assert
    assert.equal(display, expected);
    assert.equal(thinkingDisplay("high"), "high");
  });
});

function snapshot(overrides: Partial<FooterSnapshot>): FooterSnapshot {
  return {
    lines: ["cwd", statsLine("(pi-claude) claude-opus-5-5 • high"), ""],
    statuses: new Map(),
    model: MODEL,
    ...overrides,
  };
}

function columnOf(line: string, needle: string): number {
  return measure.strip(line).indexOf(needle);
}

function statsLine(rightSide: string): string {
  return `\x1b[2m↑1.2k ↓300 $0.012 12.0%/200k      ${rightSide}\x1b[0m`;
}
