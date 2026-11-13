import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { PermissionUI } from "./permission-prompt.ts";
import { selectWithDefault } from "./select-with-default.ts";

// ui.select() always starts on the first option, so a preselected answer needs the custom selector.
export function permissionUI(ui: ExtensionUIContext): PermissionUI {
  return {
    select: (title, options, preselected) =>
      preselected === undefined ? ui.select(title, options) : selectWithDefault(ui, title, options, preselected, "permission"),
    input: (title, placeholder) => ui.input(title, placeholder),
  };
}
