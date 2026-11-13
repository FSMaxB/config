import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PathRuleStore } from "./agent-mode.ts";
import { selectorLabel, type AccessMode, type PathRule, type RuleKind, type RuleTier } from "./path-permission-rules.ts";
import { addPathRule, clearPathRules, listPathRules, normalizePathSelector, removePathRule } from "./path-permissions.ts";

export const CLEAR_ALL = "Clear all";
export const DONE = "Done";

export interface DecisionEntry {
  label: string;
  remove: () => void | Promise<void>;
}

export async function managePathRules(store: PathRuleStore, context: ExtensionContext): Promise<void> {
  if (!context.hasUI) {
    context.ui.notify(`Managing ${store} path rules needs an interactive UI.`, "error");
    return;
  }
  while (true) {
    const entries = pathRuleEntries(await listPathRules(store), store);
    if (entries.length === 0) {
      context.ui.notify(`No ${store} path rules recorded.`);
      return;
    }
    const labels = entries.map((entry) => entry.label);
    const choice = await context.ui.select(`${store} path rules — pick one to remove`, [...labels, CLEAR_ALL, DONE]);
    if (choice === CLEAR_ALL) {
      await clearPathRules(store);
      context.ui.notify(`Cleared all ${store} path rules.`);
      return;
    }
    const entry = entries[labels.indexOf(choice ?? "")];
    if (!entry) return;
    await entry.remove();
  }
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
  const modeChoice = await context.ui.select(`${kind} ${pattern} for which access?`, ["read", "write", "read and write"]);
  if (modeChoice === undefined) return;
  const tierChoice = await context.ui.select("For how long?", ["This session", "Always"]);
  if (tierChoice === undefined) return;
  const tier: RuleTier = tierChoice === "Always" ? "always" : "session";
  const selector = await normalizePathSelector(pattern, context.cwd);
  const modes: AccessMode[] = modeChoice === "read and write" ? ["read", "write"] : [modeChoice as AccessMode];
  for (const mode of modes) await addPathRule({ mode, kind, tier, selector }, store);
  context.ui.notify(`Path rule added: ${kind} ${modes.join("+")} ${selectorLabel(selector)} (${tier}).`);
}

export function pathRuleEntries(rules: PathRule[], store: PathRuleStore): DecisionEntry[] {
  return rules.map((rule) => ({
    label: `${rule.mode} ${rule.kind} ${selectorLabel(rule.selector)} — path (${rule.tier})`,
    remove: () => removePathRule(rule, store),
  }));
}
