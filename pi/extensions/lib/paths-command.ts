import { isPathRuleStore, PathRuleStore } from "./agent-mode.ts";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { RuleKind } from "./path-permission-rules.ts";
import { completionItems, RULE_SUBCOMMANDS } from "./completions.ts";

// `/paths [execution|plan|explore] [grants | allow <glob> | deny <glob>]`: the mode defaults to the
// active one and the sub-command to grants. An empty pattern is passed on so the handler can show its usage.
export function parsePathsArgument(argument: string, activeStore: PathRuleStore): PathsCommand | undefined {
  const words = argument.split(/\s+/).filter((word) => word.length > 0);
  const [first] = words;
  const explicitStore = isPathRuleStore(first) ? first : undefined;
  const store = explicitStore ?? activeStore;
  const [subcommand = "grants", ...rest] = explicitStore === undefined ? words : words.slice(1);
  if (subcommand === "grants") return rest.length === 0 ? { kind: "grants", store } : undefined;
  if (subcommand !== "allow" && subcommand !== "deny") return undefined;
  return { kind: "rule", store, ruleKind: subcommand, pattern: rest.join(" ") };
}

export type PathsCommand =
  | { kind: "grants"; store: PathRuleStore }
  | { kind: "rule"; store: PathRuleStore; ruleKind: RuleKind; pattern: string };

export function pathsCompletions(prefix: string): AutocompleteItem[] | null {
  return completionItems([...Object.values(PathRuleStore), ...RULE_SUBCOMMANDS], prefix);
}
