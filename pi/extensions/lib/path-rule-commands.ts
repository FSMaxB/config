import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PathRuleStore } from "./agent-mode.ts";
import { selectorLabel } from "./path-permission-rules.ts";
import type { AccessMode, PathRule, RuleKind, RuleTier } from "./path-permission-rules.ts";
import { addPathRule, clearPathRules, listPathRules, normalizePathSelector, removePathRule } from "./path-permissions.ts";

export const CLEAR_ALL = "Clear all";
export const DONE = "Done";

export interface DecisionEntry {
  label: string;
  remove: () => void | Promise<void>;
}

export interface DecisionList {
  title: string;
  emptyMessage: string;
  clearedMessage: string;
  entries(): Promise<DecisionEntry[]>;
  clearAll(): Promise<void>;
  // Runs after each removal, for callers that keep the entries in a store of their own.
  removed(): Promise<void>;
}

export async function managePathRules(store: PathRuleStore, context: ExtensionContext): Promise<void> {
  if (!context.hasUI) {
    context.ui.notify(`Managing ${store} path rules needs an interactive UI.`, "error");
    return;
  }
  await manageDecisions(
    {
      title: `${store} path rules — pick one to remove`,
      emptyMessage: `No ${store} path rules recorded.`,
      clearedMessage: `Cleared all ${store} path rules.`,
      entries: async () => pathRuleEntries(await listPathRules(store), store),
      clearAll: () => clearPathRules(store),
      removed: async () => undefined,
    },
    context,
  );
}

// Lets the user remove decisions one at a time until they pick Done, clear them all, or none are left.
export async function manageDecisions(list: DecisionList, context: ExtensionContext): Promise<void> {
  let entries = await list.entries();
  while (entries.length > 0) {
    const choice = await context.ui.select(list.title, [...entries.map((entry) => entry.label), CLEAR_ALL, DONE]);
    if (choice === CLEAR_ALL) {
      await list.clearAll();
      context.ui.notify(list.clearedMessage);
      return;
    }
    const entry = entries.find((candidate) => candidate.label === choice);
    if (entry === undefined) return;
    await entry.remove();
    await list.removed();
    entries = await list.entries();
  }
  context.ui.notify(list.emptyMessage);
}

// `command` is everything before the rule kind in the usage hint, e.g. "/plan" or "/paths plan".
export async function addPathRuleInteractively(
  kind: RuleKind,
  pattern: string,
  store: PathRuleStore,
  command: string,
  context: ExtensionCommandContext,
): Promise<void> {
  if (!pattern) {
    context.ui.notify(`Usage: ${command} ${kind} <path-or-glob>`, "error");
    return;
  }
  if (!context.hasUI) {
    context.ui.notify("Adding path rules needs an interactive UI.", "error");
    return;
  }
  const modeChoice = await context.ui.select(`${kind} ${pattern} for which access?`, [...ACCESS_CHOICES.keys()]);
  const modes = modeChoice === undefined ? undefined : ACCESS_CHOICES.get(modeChoice);
  if (modes === undefined) return;
  const tierChoice = await context.ui.select("For how long?", [...TIER_CHOICES.keys()]);
  const tier = tierChoice === undefined ? undefined : TIER_CHOICES.get(tierChoice);
  if (tier === undefined) return;
  const selector = await normalizePathSelector(pattern, context.cwd);
  for (const mode of modes) {
    const rule: PathRule = kind === "allow" ? { mode, kind, tier, selector } : { mode, kind, tier, selector, note: undefined };
    await addPathRule(rule, store);
  }
  context.ui.notify(`Path rule added: ${kind} ${modes.join("+")} ${selectorLabel(selector)} (${tier}).`);
}

const ACCESS_CHOICES: ReadonlyMap<string, readonly AccessMode[]> = new Map([
  ["read", ["read"]],
  ["write", ["write"]],
  ["read and write", ["read", "write"]],
]);

const TIER_CHOICES: ReadonlyMap<string, RuleTier> = new Map([
  ["This session", "session"],
  ["Always", "always"],
]);

export function pathRuleEntries(rules: readonly PathRule[], store: PathRuleStore): DecisionEntry[] {
  return rules.map((rule) => ({
    label: `${rule.mode} ${rule.kind} ${selectorLabel(rule.selector)} — path (${rule.tier})${rule.kind === "deny" && rule.note ? `: ${rule.note}` : ""}`,
    remove: () => removePathRule(rule, store),
  }));
}
