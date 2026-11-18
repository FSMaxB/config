import type { BashToolDetails, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export function withSandboxProfiles(details: BashToolDetails | undefined, profiles: readonly string[]): SandboxedBashDetails | undefined {
  if (profiles.length === 0) return details;
  return { ...details, sandboxProfiles: profiles };
}

/** Stock bash details plus the sandbox profiles the call ran with; the field is absent when none applied. */
export interface SandboxedBashDetails extends BashToolDetails {
  sandboxProfiles?: readonly string[];
}

export function callPrefix(mode: CallMode, theme: PrefixTheme): string {
  switch (mode.kind) {
    case "unsandboxed":
      return `${theme.fg("warning", theme.bold("unsandboxed"))} `;
    case "sandboxed":
      return mode.profiles.length === 0 ? "" : `${theme.fg("accent", `[${mode.profiles.join(", ")}]`)} `;
  }
}

export type CallMode = { kind: "unsandboxed" } | { kind: "sandboxed"; profiles: readonly string[] };

type PrefixTheme = Pick<Theme, "fg" | "bold">;

/**
 * The stock bash call line behind a prefix computed when the line is drawn: the profiles arrive with the
 * result, and pi renders a row's call before its result.
 */
export class PrefixedCallText extends Text {
  #call = "";
  #prefix: () => string = () => "";

  constructor() {
    super("", 0, 0);
  }

  setPrefix(prefix: () => string): void {
    this.#prefix = prefix;
  }

  // The stock renderer sets the `$ command` text through this.
  override setText(text: string): void {
    this.#call = text;
  }

  override render(width: number): string[] {
    super.setText(this.#prefix() + this.#call);
    return super.render(width);
  }
}
