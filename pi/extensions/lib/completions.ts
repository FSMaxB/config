import type { AutocompleteItem } from "@earendil-works/pi-tui";

// The sub-commands every command that manages path rules accepts after its own arguments.
export const RULE_SUBCOMMANDS = ["grants", "allow", "deny"] as const;

// pi's argument completion treats null as "no completions".
export function completionItems(values: readonly string[], prefix: string): AutocompleteItem[] | null {
  const items = values.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
  return items.length > 0 ? items : null;
}
