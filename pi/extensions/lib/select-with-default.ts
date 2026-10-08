import type {
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSelectListTheme, keyText } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type KeybindingsManager,
  SelectList,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";

// ui.select() always starts on the first option, so a dialog that wants to
// recommend something else has to bring its own selector. SelectList windows
// the visible rows around the selection, so long lists scroll instead of
// overflowing the screen.
export async function selectWithDefault(
  ui: ExtensionUIContext,
  title: string,
  options: string[],
  defaultOption: string,
): Promise<string | undefined> {
  const defaultIndex = Math.max(0, options.indexOf(defaultOption));
  return await ui.custom<string | undefined>((tui, theme, keybindings, done) => {
    // rows - 12 reserves the dialog chrome (borders, spacers, title, hints,
    // scroll-info line, margin); floor of 3 keeps a window on tiny terminals,
    // and the cap at options.length renders short lists in full as before.
    const maxVisible = Math.max(
      3,
      Math.min(options.length, tui.terminal.rows - 12),
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
  });
}

class DefaultSelector extends Container {
  private selectedIndex: number;
  private readonly list: SelectList;

  constructor(
    title: string,
    private readonly options: string[],
    defaultIndex: number,
    maxVisible: number,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly done: (result: string | undefined) => void,
  ) {
    super();
    this.selectedIndex = defaultIndex;
    this.list = new SelectList(
      options.map((option) => ({ value: option, label: option })),
      maxVisible,
      getSelectListTheme(),
    );
    this.list.setSelectedIndex(defaultIndex);
    // Container dispatches mouse events to children, so SelectList gets wheel
    // and click for free; these callbacks close the dialog on a mouse pick.
    this.list.onSelect = (item) => this.done(item.value);
    this.list.onCancel = () => this.done(undefined);

    const border = () => new DynamicBorder((text) => theme.fg("border", text));
    this.addChild(border());
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(this.list);
    this.addChild(new Spacer(1));
    this.addChild(new Text(this.hints(), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(border());
  }

  // Keyboard stays hand-rolled instead of delegating to SelectList.handleInput:
  // that one wraps around at the ends and ignores j/k, neither of which we want.
  handleInput(keyData: string): void {
    const { keybindings, options } = this;
    if (keybindings.matches(keyData, "tui.select.up") || keyData === "k") {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.list.setSelectedIndex(this.selectedIndex);
      return;
    }
    if (keybindings.matches(keyData, "tui.select.down") || keyData === "j") {
      this.selectedIndex = Math.min(options.length - 1, this.selectedIndex + 1);
      this.list.setSelectedIndex(this.selectedIndex);
      return;
    }
    if (keybindings.matches(keyData, "tui.select.confirm") || keyData === "\n") {
      this.done(options[this.selectedIndex]);
      return;
    }
    if (keybindings.matches(keyData, "tui.select.cancel")) {
      this.done(undefined);
    }
  }

  private hints(): string {
    const { theme } = this;
    const hint = (keys: string, description: string) =>
      theme.fg("dim", keys) + theme.fg("muted", ` ${description}`);
    return [
      hint("↑↓", "navigate"),
      hint(keyText("tui.select.confirm"), "select"),
      hint(keyText("tui.select.cancel"), "cancel"),
    ].join("  ");
  }
}
