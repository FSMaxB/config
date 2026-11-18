import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

// The box takes at most one third of the terminal width.
const MAX_TERMINAL_SHARE_DENOMINATOR = 3;
/** The box never takes more than this share of the terminal width. */
export const MAX_TERMINAL_SHARE = 1 / MAX_TERMINAL_SHARE_DENOMINATOR;
// Below this a third of the width is too narrow for a path, and the box would cover the transcript.
export const MIN_TERMINAL_WIDTH = 100;
// Two border columns plus one space of padding on each side.
const BORDER_AND_PADDING_COLUMNS = 4;

export const ItemTone = { Normal: "normal", Dim: "dim" } as const;

export class SidebarPanel implements Component {
  readonly #theme: Theme;
  readonly #measure: TextMeasure;
  readonly #sections: () => readonly PanelSection[];

  constructor(theme: Theme, measure: TextMeasure, sections: () => readonly PanelSection[]) {
    this.#theme = theme;
    this.#measure = measure;
    this.#sections = sections;
  }

  width(terminalWidth: number): number {
    return panelWidth(this.#sections(), this.#measure, terminalWidth);
  }

  render(width: number): string[] {
    const style = {
      border: (text: string) => this.#theme.fg("border", text),
      title: (text: string) => this.#theme.fg("accent", text),
      dim: (text: string) => this.#theme.fg("dim", text),
    };
    return renderPanel(this.#sections(), width, style, this.#measure);
  }

  invalidate(): void {}
}

/** Box width for the non-empty sections: widest row plus borders and padding, capped by the terminal width. */
export function panelWidth(sections: readonly PanelSection[], measure: TextMeasure, terminalWidth: number): number {
  const rows = sections.flatMap((section) => [section.title, ...section.items.map((item) => itemIndent(item) + item.text)]);
  const widest = Math.max(0, ...rows.map((row) => measure.width(row)));
  return Math.min(widest + BORDER_AND_PADDING_COLUMNS, Math.floor(terminalWidth * MAX_TERMINAL_SHARE));
}

export function renderPanel(
  sections: readonly PanelSection[],
  width: number,
  style: PanelStyle,
  measure: TextMeasure,
): string[] {
  const inner = width - 2;
  const row = (text: string): string => {
    const fitted = measure.truncate(` ${text}`, inner - 1, "…");
    return style.border("│") + fitted + " ".repeat(Math.max(0, inner - measure.width(fitted))) + style.border("│");
  };
  const lines = [style.border(`╭${"─".repeat(inner)}╮`)];
  for (const [position, section] of sections.entries()) {
    if (position > 0) lines.push(style.border(`├${"─".repeat(inner)}┤`));
    lines.push(row(style.title(section.title)), ...section.items.map((item) => row(itemIndent(item) + styledText(item, style))));
  }
  lines.push(style.border(`╰${"─".repeat(inner)}╯`));
  return lines;
}
export interface PanelSection { title: string; items: readonly PanelItem[] }

/**
 * The terminal width helpers of pi-tui, injected so this module stays loadable by the package-less
 * `node --test` run in CI, where pi-tui is not installed.
 */
export interface TextMeasure {
  width(text: string): number;
  truncate(text: string, maxWidth: number, ellipsis: string): string;
}

/** Leading spaces of an item row inside the box: one for every item, two more per depth level. */
function itemIndent(item: PanelItem): string {
  return " ".repeat(1 + 2 * item.depth);
}

function styledText(item: PanelItem, style: PanelStyle): string {
  return item.tone === ItemTone.Dim ? style.dim(item.text) : item.text;
}

/** `depth` is layout: the panel indents two spaces per level. `tone` picks the text style. */
export interface PanelItem { text: string; depth: number; tone: ItemTone }
export type ItemTone = (typeof ItemTone)[keyof typeof ItemTone];
export interface PanelStyle {
  border(text: string): string;
  title(text: string): string;
  dim(text: string): string;
}
