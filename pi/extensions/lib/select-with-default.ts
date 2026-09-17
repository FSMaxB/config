import type {
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder, keyText } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type KeybindingsManager,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";

// ui.select() always starts on the first option, so a dialog that wants to
// recommend something else has to bring its own selector.
export async function selectWithDefault(
  ui: ExtensionUIContext,
  title: string,
  options: string[],
  defaultOption: string,
): Promise<string | undefined> {
  const defaultIndex = Math.max(0, options.indexOf(defaultOption));
  return await ui.custom<string | undefined>(
    (_tui, theme, keybindings, done) =>
      new DefaultSelector(title, options, defaultIndex, theme, keybindings, done),
  );
}

class DefaultSelector extends Container {
  private selectedIndex: number;
  private readonly list = new Container();

  constructor(
    title: string,
    private readonly options: string[],
    defaultIndex: number,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly done: (result: string | undefined) => void,
  ) {
    super();
    this.selectedIndex = defaultIndex;
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
    this.renderList();
  }

  handleInput(keyData: string): void {
    const { keybindings, options } = this;
    if (keybindings.matches(keyData, "tui.select.up") || keyData === "k") {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.renderList();
      return;
    }
    if (keybindings.matches(keyData, "tui.select.down") || keyData === "j") {
      this.selectedIndex = Math.min(options.length - 1, this.selectedIndex + 1);
      this.renderList();
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

  private renderList(): void {
    const { theme } = this;
    this.list.clear();
    this.options.forEach((option, index) => {
      const line =
        index === this.selectedIndex
          ? theme.fg("accent", `→ ${option}`)
          : `  ${theme.fg("text", option)}`;
      this.list.addChild(new Text(line, 1, 0));
    });
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
