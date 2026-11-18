// Layout of the details pane under selectWithDefault's list. The width
// helpers are injected because CI runs lib tests with plain node --test,
// which has no pi-tui.

export interface TextMeasure {
  width(text: string): number;
  wrap(text: string, width: number): string[];
}

// SelectList draws "→ " or "  " before each label and keeps two more columns
// free, so a label gets width - 4 columns before it is cut.
const LIST_ROW_CHROME = 4;
// The pane indents by one column, like the dialog's Text components, and
// keeps one column free on the right.
const PANE_INDENT = 2;

export function detailsLines(
  options: readonly string[],
  selectedIndex: number,
  width: number,
  measure: TextMeasure,
): string[] {
  const height = detailsHeight(options, width, measure);
  if (height === 0) return [];

  const lines = measure.wrap(options[selectedIndex] ?? "", width - PANE_INDENT);
  return [...lines, ...new Array<string>(height - lines.length).fill("")];
}

// Every option gets the height of the tallest cut option, so the dialog does
// not change height while the user moves through the list.
export function detailsHeight(
  options: readonly string[],
  width: number,
  measure: TextMeasure,
): number {
  const cut = options.filter((option) => measure.width(option) > width - LIST_ROW_CHROME);
  return Math.max(0, ...cut.map((option) => measure.wrap(option, width - PANE_INDENT).length));
}
