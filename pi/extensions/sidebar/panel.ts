import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

export const MAX_WIDTH = 32;
export const MIN_TERMINAL_WIDTH = 100;

export type PanelSection = { title: string; items: readonly string[] };
export type PanelStyle = { border(text: string): string; title(text: string): string };

/**
 * The terminal width helpers of pi-tui, injected so this module stays loadable by the package-less
 * `node --test` run in CI, where pi-tui is not installed.
 */
export type TextMeasure = {
  width(text: string): number;
  truncate(text: string, maxWidth: number, ellipsis: string): string;
};

export class SidebarPanel implements Component {
  private readonly theme: Theme;
  private readonly measure: TextMeasure;
  private readonly sections: () => readonly PanelSection[];

  constructor(theme: Theme, measure: TextMeasure, sections: () => readonly PanelSection[]) {
    this.theme = theme;
    this.measure = measure;
    this.sections = sections;
  }

  width(): number {
    return panelWidth(this.sections(), this.measure);
  }

  render(width: number): string[] {
    const style = {
      border: (text: string) => this.theme.fg("border", text),
      title: (text: string) => this.theme.fg("accent", text),
    };
    return renderPanel(this.sections(), width, style, this.measure);
  }

  invalidate(): void {}
}

/** Box width for the non-empty sections: widest row plus borders and padding, capped. */
export function panelWidth(sections: readonly PanelSection[], measure: TextMeasure): number {
  const rows = sections.flatMap((section) => [section.title, ...section.items.map((item) => ` ${item}`)]);
  const widest = Math.max(0, ...rows.map((row) => measure.width(row)));
  return Math.min(widest + 4, MAX_WIDTH);
}

export function renderPanel(
  sections: readonly PanelSection[],
  width: number,
  style: PanelStyle,
  measure: TextMeasure,
): string[] {
  const inner = width - 2;
  const row = (text: string) => {
    const fitted = measure.truncate(` ${text}`, inner - 1, "…");
    return style.border("│") + fitted + " ".repeat(Math.max(0, inner - measure.width(fitted))) + style.border("│");
  };
  const lines = [style.border(`╭${"─".repeat(inner)}╮`)];
  sections.forEach((section, position) => {
    if (position > 0) lines.push(style.border(`├${"─".repeat(inner)}┤`));
    lines.push(row(style.title(section.title)), ...section.items.map((item) => row(` ${item}`)));
  });
  lines.push(style.border(`╰${"─".repeat(inner)}╯`));
  return lines;
}
