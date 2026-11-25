import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import type { PermissionUI } from "./permission-prompt.ts";
import { selectWithDefault } from "./select-with-default.ts";

// ui.select() and ui.input() report a question to terminals with program status (OSC 7501); every
// dialog of a permission prompt, follow-ups included, reports a permission request instead.
const PERMISSION_DIALOG = { blockedKind: "permission" } as const satisfies ExtensionUIDialogOptions;

// ui.select() always starts on the first option, so a preselected answer needs the custom selector.
export function permissionUI(ui: ExtensionUIContext): PermissionUI {
  return {
    select: (title, options, preselected) =>
      preselected === undefined ? ui.select(title, [...options], PERMISSION_DIALOG) : selectWithDefault(ui, title, options, preselected, "permission"),
    input: (title, placeholder) => ui.input(title, placeholder, PERMISSION_DIALOG),
  };
}
