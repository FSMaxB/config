import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_TERMINAL_SHARE, type PanelStyle, panelWidth, renderPanel, type TextMeasure } from "./panel.ts";

const plain: PanelStyle = { border: (text) => text, title: (text) => text };
const measure: TextMeasure = {
  width: (text) => text.length,
  truncate: (text, maxWidth, ellipsis) =>
    text.length <= maxWidth ? text : text.slice(0, maxWidth - ellipsis.length) + ellipsis,
};
const skills = { title: "Skills", items: ["planning", "code-style"] };
const other = { title: "Other", items: ["item"] };
const terminalWidth = 120;

test("renderPanel draws one section as a box", () => {
  // arrange
  const sections = [skills];

  // act
  const lines = renderPanel(sections, panelWidth(sections, measure, terminalWidth), plain, measure);

  // assert
  assert.deepEqual(lines, [
    "╭─────────────╮",
    "│ Skills      │",
    "│  planning   │",
    "│  code-style │",
    "╰─────────────╯",
  ]);
});

test("renderPanel separates sections with a divider", () => {
  // arrange
  const sections = [skills, other];

  // act
  const lines = renderPanel(sections, panelWidth(sections, measure, terminalWidth), plain, measure);

  // assert
  assert.deepEqual(lines, [
    "╭─────────────╮",
    "│ Skills      │",
    "│  planning   │",
    "│  code-style │",
    "├─────────────┤",
    "│ Other       │",
    "│  item       │",
    "╰─────────────╯",
  ]);
});

test("renderPanel makes every line exactly as wide as asked", () => {
  // arrange
  const sections = [skills, other, { title: "Long", items: ["x".repeat(80)] }];
  const width = panelWidth(sections, measure, terminalWidth);

  // act
  const lines = renderPanel(sections, width, plain, measure);

  // assert
  assert.deepEqual(
    lines.map((line) => measure.width(line)),
    lines.map(() => width),
  );
});

test("renderPanel truncates long items with an ellipsis", () => {
  // arrange
  const sections = [{ title: "Skills", items: ["x".repeat(80)] }];

  // act
  const lines = renderPanel(sections, panelWidth(sections, measure, terminalWidth), plain, measure);

  // assert
  assert.match(lines[2], /… │$/);
});

test("panelWidth caps at a share of the terminal width", () => {
  // arrange
  const sections = [{ title: "Skills", items: ["x".repeat(80)] }];

  // act
  const width = panelWidth(sections, measure, terminalWidth);

  // assert
  assert.equal(width, Math.floor(terminalWidth * MAX_TERMINAL_SHARE));
});

test("panelWidth grows past the old fixed cap on wide terminals", () => {
  // arrange
  const sections = [{ title: "Skills", items: ["x".repeat(36)] }];

  // act
  const width = panelWidth(sections, measure, 200);

  // assert
  assert.equal(width, 41);
});
