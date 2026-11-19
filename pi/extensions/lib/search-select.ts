import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSelectListTheme, keyText } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, SelectList, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Focusable, KeybindingsManager } from "@earendil-works/pi-tui";
import { DIALOG_CHROME_ROWS, MINIMUM_VISIBLE_ROWS } from "./select-with-default.ts";
import type { WaitKind } from "./select-with-default.ts";

// The search input and the spacer below it, on top of the rows selectWithDefault's dialog uses.
const SEARCH_ROWS = 2;

// selectWithDefault with a search field above the list: typing narrows the options with pi's
// fuzzy matcher, the arrow keys move through the matches and a click on a row picks it. Every
// letter goes to the search field, so unlike selectWithDefault there are no vim keys.
export async function searchWithDefault(
  ui: ExtensionUIContext,
  title: string,
  options: readonly string[],
  defaultOption: string,
  waitKind: WaitKind,
): Promise<string | undefined> {
  return await ui.custom<string | undefined>(
    (tui, theme, keybindings, done) => {
      // Sized once, like selectWithDefault's window; the list shrinks below it while filtering.
      const maxVisible = Math.max(
        MINIMUM_VISIBLE_ROWS,
        Math.min(options.length, tui.terminal.rows - DIALOG_CHROME_ROWS - SEARCH_ROWS),
      );
      return new SearchSelector({ title, options, defaultOption, maxVisible, theme, keybindings, done });
    },
    { blocked: { kind: waitKind, message: title } },
  );
}

class SearchSelector extends Container implements Focusable {
  readonly #entries: readonly IndexedOption[];
  readonly #defaultOption: string;
  readonly #maxVisible: number;
  readonly #theme: Theme;
  readonly #keybindings: KeybindingsManager;
  readonly #done: (result: string | undefined) => void;
  readonly #input = new Input();
  readonly #listSlot = new Container();
  #list: SelectList;
  #query = "";

  constructor(parameters: SearchSelectorParameters) {
    super();
    const { title, options, theme } = parameters;
    this.#entries = options.map((label, index) => ({ label, index }));
    this.#defaultOption = parameters.defaultOption;
    this.#maxVisible = parameters.maxVisible;
    this.#theme = theme;
    this.#keybindings = parameters.keybindings;
    this.#done = parameters.done;
    this.#list = this.#createList(this.#query);
    this.#listSlot.addChild(this.#list);

    const border = (): DynamicBorder => new DynamicBorder((text) => theme.fg("border", text));
    this.addChild(border());
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(this.#input);
    this.addChild(new Spacer(1));
    this.addChild(this.#listSlot);
    this.addChild(new Spacer(1));
    this.addChild(new Text(this.#hints(), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(border());
  }

  // pi-tui positions the IME window and the cursor from the focused component, so a container
  // that wraps an Input has to hand focus on to it.
  get focused(): boolean {
    return this.#input.focused;
  }

  // eslint-disable-next-line no-restricted-syntax -- Focusable declares focused as a boolean property.
  set focused(value: boolean) {
    this.#input.focused = value;
  }

  handleInput(keyData: string): void {
    const keybindings = this.#keybindings;
    if (keybindings.matches(keyData, "tui.select.up") || keybindings.matches(keyData, "tui.select.down")) {
      this.#list.handleInput(keyData);
      return;
    }
    if (keybindings.matches(keyData, "tui.select.confirm")) {
      const item = this.#list.getSelectedItem();
      if (item) this.#done(this.#optionAt(item.value));
      return;
    }
    if (keybindings.matches(keyData, "tui.select.cancel")) {
      this.#done(undefined);
      return;
    }

    this.#input.handleInput(keyData);
    const query = this.#input.getValue();
    if (query === this.#query) return;
    this.#query = query;
    this.#rebuildList(query);
  }

  #rebuildList(query: string): void {
    this.#list = this.#createList(query);
    this.#listSlot.clear();
    this.#listSlot.addChild(this.#list);
  }

  #createList(query: string): SelectList {
    const matches = query === "" ? this.#entries : fuzzyFilter([...this.#entries], query, ({ label }) => label);
    const list = new SelectList(
      // Values are indices, as in selectWithDefault.
      matches.map(({ label, index }) => ({ value: String(index), label })),
      this.#maxVisible,
      getSelectListTheme(),
      { truncatePrimary: ({ text, maxWidth }) => truncateToWidth(text, maxWidth, "…") },
    );
    const preselected = query === "" ? matches.findIndex(({ label }) => label === this.#defaultOption) : 0;
    list.setSelectedIndex(Math.max(0, preselected));
    // Container dispatches mouse events to its children, so a click on a row ends up here.
    list.onSelect = (item) => this.#done(this.#optionAt(item.value));
    list.onCancel = () => this.#done(undefined);
    return list;
  }

  #optionAt(value: string): string | undefined {
    return this.#entries[Number(value)]?.label;
  }

  #hints(): string {
    const theme = this.#theme;
    const hint = (keys: string, description: string): string => theme.fg("dim", keys) + theme.fg("muted", ` ${description}`);
    return [
      hint("type", "to search"),
      hint("↑↓", "navigate"),
      hint(keyText("tui.select.confirm"), "select"),
      hint(keyText("tui.select.cancel"), "cancel"),
    ].join("  ");
  }
}

interface SearchSelectorParameters {
  title: string;
  options: readonly string[];
  defaultOption: string;
  maxVisible: number;
  theme: Theme;
  keybindings: KeybindingsManager;
  done: (result: string | undefined) => void;
}

interface IndexedOption {
  label: string;
  // Position in the original options, so a pick maps back even when two options read the same.
  index: number;
}
