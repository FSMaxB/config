import type {
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSelectListTheme, keyText } from "@earendil-works/pi-coding-agent";
import {
  Container,
  SelectList,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type {
  Component,
  KeybindingsManager,
  ProgramStatus,
} from "@earendil-works/pi-tui";
import { detailsHeight, detailsLines } from "./select-details.ts";
import type { TextMeasure } from "./select-details.ts";

const measure: TextMeasure = { width: visibleWidth, wrap: wrapTextWithAnsi };

// The dialog chrome around the list: borders, spacers, title, hints, scroll-info line and a margin.
export const DIALOG_CHROME_ROWS = 12;
// Keeps a usable window on tiny terminals.
export const MINIMUM_VISIBLE_ROWS = 3;

// ui.select() always starts on the first option, so a dialog that wants to
// recommend something else has to bring its own selector. SelectList windows
// the visible rows around the selection, so long lists scroll instead of
// overflowing the screen. Unlike ui.select(), ui.custom() does not tell the
// terminal (OSC 7501) that pi waits for the user, hence the blocked option.
export async function selectWithDefault(
  ui: ExtensionUIContext,
  title: string,
  options: readonly string[],
  defaultOption: string,
  waitKind: WaitKind,
): Promise<string | undefined> {
  const defaultIndex = Math.max(0, options.indexOf(defaultOption));
  return await ui.custom<string | undefined>((tui, theme, keybindings, done) => {
    // The details pane and its spacer take rows too when an option is too wide for its row. The
    // window is sized once, so resizing the terminal while the dialog is open can overflow it or
    // leave room unused. Short lists render in full.
    const paneHeight = detailsHeight(options, tui.terminal.columns, measure);
    const paneRows = paneHeight > 0 ? paneHeight + 1 : 0;
    const maxVisible = Math.max(
      MINIMUM_VISIBLE_ROWS,
      Math.min(options.length, tui.terminal.rows - DIALOG_CHROME_ROWS - paneRows),
    );
    return new DefaultSelector(
      title,
      options,
      defaultIndex,
      maxVisible,
      theme,
      keybindings,
      done,
    );
  }, { blocked: { kind: waitKind, message: title } });
}

export type WaitKind = NonNullable<ProgramStatus["kind"]>;

class DefaultSelector extends Container {
  #selectedIndex: number;
  readonly #list: SelectList;
  readonly #options: readonly string[];
  readonly #theme: Theme;
  readonly #keybindings: KeybindingsManager;
  readonly #done: (result: string | undefined) => void;

  constructor(
    title: string,
    options: readonly string[],
    defaultIndex: number,
    maxVisible: number,
    theme: Theme,
    keybindings: KeybindingsManager,
    done: (result: string | undefined) => void,
  ) {
    super();
    this.#options = options;
    this.#theme = theme;
    this.#keybindings = keybindings;
    this.#done = done;
    this.#selectedIndex = defaultIndex;
    this.#list = new SelectList(
      // Values are indices, so a pick maps back to its option by position even
      // when two options read the same.
      options.map((option, index) => ({ value: String(index), label: option })),
      maxVisible,
      getSelectListTheme(),
      { truncatePrimary: ({ text, maxWidth }) => truncateToWidth(text, maxWidth, "…") },
    );
    this.#list.setSelectedIndex(defaultIndex);
    // Container dispatches mouse events to children, so SelectList gets wheel
    // and click for free. The wheel moves SelectList's selection without going
    // through handleInput, so onSelectionChange keeps selectedIndex, and with
    // it Enter and the details pane, in step.
    this.#list.onSelectionChange = (item) => {
      this.#selectedIndex = Number(item.value);
    };
    this.#list.onSelect = (item) => this.#done(options[Number(item.value)]);
    this.#list.onCancel = () => this.#done(undefined);

    const border = () => new DynamicBorder((text) => theme.fg("border", text));
    this.addChild(border());
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(this.#list);
    this.addChild(new DetailsPane(options, () => this.#selectedIndex, theme));
    this.addChild(new Spacer(1));
    this.addChild(new Text(this.#hints(), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(border());
  }

  get options(): readonly string[] {
    return this.#options;
  }

  // Keyboard stays hand-rolled instead of delegating to SelectList.handleInput:
  // that one wraps around at the ends and ignores j/k, neither of which we want.
  handleInput(keyData: string): void {
    const keybindings = this.#keybindings;
    const options = this.#options;
    if (keybindings.matches(keyData, "tui.select.up") || keyData === "k") {
      this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
      this.#list.setSelectedIndex(this.#selectedIndex);
      return;
    }
    if (keybindings.matches(keyData, "tui.select.down") || keyData === "j") {
      this.#selectedIndex = Math.min(options.length - 1, this.#selectedIndex + 1);
      this.#list.setSelectedIndex(this.#selectedIndex);
      return;
    }
    if (keybindings.matches(keyData, "tui.select.confirm") || keyData === "\n") {
      this.#done(options[this.#selectedIndex]);
      return;
    }
    if (keybindings.matches(keyData, "tui.select.cancel")) {
      this.#done(undefined);
    }
  }

  #hints(): string {
    const theme = this.#theme;
    const hint = (keys: string, description: string): string =>
      theme.fg("dim", keys) + theme.fg("muted", ` ${description}`);
    return [
      hint("↑↓", "navigate"),
      hint(keyText("tui.select.confirm"), "select"),
      hint(keyText("tui.select.cancel"), "cancel"),
    ].join("  ");
  }
}

// SelectList cuts every label to one row, so the full text of the highlighted
// option is repeated here, wrapped.
class DetailsPane implements Component {
  readonly #options: readonly string[];
  readonly #selectedIndex: () => number;
  readonly #theme: Theme;

  constructor(options: readonly string[], selectedIndex: () => number, theme: Theme) {
    this.#options = options;
    this.#selectedIndex = selectedIndex;
    this.#theme = theme;
  }

  render(width: number): string[] {
    const lines = detailsLines(this.#options, this.#selectedIndex(), width, measure);
    if (lines.length === 0) return [];
    return ["", ...lines.map((line) => ` ${this.#theme.fg("text", line)}`)];
  }

  invalidate(): void {}
}
