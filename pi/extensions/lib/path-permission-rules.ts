import { homedir } from "node:os";
import { join, matchesGlob, relative, sep } from "node:path";
import { expandHome } from "./path-resolution.ts";


export type AccessMode = "read" | "write";
export type RuleKind = "allow" | "deny";
export type RuleTier = "session" | "always";
export type Verdict = "allow" | "deny" | "prompt";

export type PathSelector =
  | { kind: "exact"; path: string }
  | { kind: "tree"; path: string }
  | { kind: "glob"; base: string; pattern: string };

export interface PathRule {
  mode: AccessMode;
  kind: RuleKind;
  tier: RuleTier;
  selector?: PathSelector;
  pattern?: string;
}

export interface RuleSets {
  read: { allow: Set<string>; deny: Set<string> };
  write: { allow: Set<string>; deny: Set<string> };
}

export interface SerializedRules {
  version: 2;
  read: { allow: PathSelector[]; deny: PathSelector[] };
  write: { allow: PathSelector[]; deny: PathSelector[] };
}

export interface DefaultAllowedOptions {
  planMode: boolean;
  repoRoot: string;
  memoryDirectory: string;
  planPath: string | undefined;
  skillRoots: string[];
  agentDirectory: string;
}

export interface RuleTiers { session: RuleSets; always: RuleSets }

export function emptyRules(): RuleSets {
  return { read: { allow: new Set(), deny: new Set() }, write: { allow: new Set(), deny: new Set() } };
}

export function selectorKey(selector: PathSelector): string {
  return selector.kind === "glob"
    ? JSON.stringify([selector.kind, selector.base, selector.pattern])
    : JSON.stringify([selector.kind, selector.path]);
}

export function selectorLabel(selector: PathSelector): string {
  return selector.kind === "exact" ? selector.path : selector.kind === "tree" ? `${selector.path}${sep}**` : `${selector.base}${sep}${selector.pattern}`;
}

export function serializeRules(rules: RuleSets): SerializedRules {
  return {
    version: 2,
    read: { allow: selectors(rules.read.allow), deny: selectors(rules.read.deny) },
    write: { allow: selectors(rules.write.allow), deny: selectors(rules.write.deny) },
  };
}
export function parseRules(value: unknown): RuleSets {
  if (!value || typeof value !== "object") throw new Error("Invalid path permission rules");
  const record = value as Record<string, unknown>;
  if (record.version === 2) {
    if (!isRuleMode(record.read) || !isRuleMode(record.write)) throw new Error("Invalid path permission rules");
    return { read: parseModeRules(record.read), write: parseModeRules(record.write) };
  }
  if ("version" in record) throw new Error(`Unsupported path permission rules version: ${String(record.version)}`);
  if (!("read" in record) && !("write" in record)) throw new Error("Invalid path permission rules");
  return { read: parseLegacyMode(record.read), write: parseLegacyMode(record.write) };
}

export function matchesRule(resolvedPath: string, selector: PathSelector | string): boolean {
  const normalized = typeof selector === "string" ? legacySelector(selector) : selector;
  if (normalized.kind === "exact") return resolvedPath === normalized.path;
  if (normalized.kind === "tree") return contains(normalized.path, resolvedPath);
  return contains(normalized.base, resolvedPath) && matchesGlob(relative(normalized.base, resolvedPath), normalized.pattern);
}

export function evaluate(resolvedPath: string, mode: AccessMode, layers: { defaults: Iterable<PathSelector | string>; always: RuleSets; session: RuleSets }): Verdict {
  const { defaults, always, session } = layers;
  if (matchesAny(resolvedPath, always[mode].deny) || matchesAny(resolvedPath, session[mode].deny)) return "deny";
  if (matchesAny(resolvedPath, defaults) || matchesAny(resolvedPath, always[mode].allow) || matchesAny(resolvedPath, session[mode].allow)) return "allow";
  return "prompt";
}

export function defaultAllowed(mode: AccessMode, options: DefaultAllowedOptions): PathSelector[] {
  const { planMode, repoRoot, memoryDirectory, planPath, skillRoots, agentDirectory } = options;
  const scratch = [tree(memoryDirectory), ...(planPath === undefined ? [] : [exact(planPath)])];
  if (mode === "read") return [tree(repoRoot), ...scratch, tree(join(homedir(), ".crit")), tree(join(agentDirectory, "plans")), ...skillRoots.map(tree)];
  return planMode ? scratch : [tree(repoRoot), ...scratch];
}

export function exact(path: string): PathSelector { return { kind: "exact", path }; }
export function tree(path: string): PathSelector { return { kind: "tree", path }; }
export function glob(base: string, pattern: string): PathSelector { return { kind: "glob", base, pattern }; }
export function subtree(directory: string): string { return join(directory, "**"); }

export function recordRule(rule: PathRule, tiers: RuleTiers): Set<RuleTier> {
  const changed = new Set<RuleTier>([rule.tier]);
  const opposite = rule.kind === "allow" ? "deny" : "allow";
  const otherTier = rule.tier === "session" ? "always" : "session";
  const key = selectorKey(rule.selector ?? legacySelector(rule.pattern ?? ""));
  tiers[rule.tier][rule.mode][rule.kind].add(key);
  tiers[rule.tier][rule.mode][opposite].delete(key);
  if (rule.pattern) tiers[rule.tier][rule.mode][opposite].delete(rule.pattern);
  if (tiers[otherTier][rule.mode][opposite].delete(key) || (rule.pattern !== undefined && tiers[otherTier][rule.mode][opposite].delete(rule.pattern))) changed.add(otherTier);
  return changed;
}

function selectors(values: Set<string>): PathSelector[] {
  return [...values].map((value) => JSON.parse(value) as PathSelector).sort((left, right) => selectorKey(left).localeCompare(selectorKey(right)));
}
function parseModeRules(value: Record<string, unknown>): RuleSets[AccessMode] { return { allow: new Set((value.allow as PathSelector[]).map(selectorKey)), deny: new Set((value.deny as PathSelector[]).map(selectorKey)) }; }
function parseLegacyMode(value: unknown): RuleSets[AccessMode] {
  if (!value || typeof value !== "object") return { allow: new Set(), deny: new Set() };
  const record = value as Record<string, unknown>;
  return { allow: new Set(legacySelectors(record.allow).map(selectorKey)), deny: new Set(legacySelectors(record.deny).map(selectorKey)) };
}
function legacySelectors(value: unknown): PathSelector[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.includes("*") || item.includes("?") || /[\[\]{}]/.test(item) ? glob("/", expandHome(item)) : exact(expandHome(item))) : []; }
function isRuleMode(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && Array.isArray((value as any).allow) && Array.isArray((value as any).deny) && [...(value as any).allow, ...(value as any).deny].every(isSelector); }
function isSelector(value: unknown): value is PathSelector { if (!value || typeof value !== "object") return false; const item = value as any; return item.kind === "exact" || item.kind === "tree" ? typeof item.path === "string" : item.kind === "glob" && typeof item.base === "string" && typeof item.pattern === "string"; }
function matchesAny(path: string, selectorsOrKeys: Iterable<string | PathSelector>): boolean { for (const value of selectorsOrKeys) { const selector = typeof value === "string" && value.startsWith("[") ? JSON.parse(value) as PathSelector : typeof value === "string" ? legacySelector(value) : value; if (matchesRule(path, selector)) return true; } return false; }

function contains(root: string, path: string): boolean {
  const remainder = relative(root, path);
  return remainder === "" || (!remainder.startsWith(`..${sep}`) && remainder !== ".." && !remainder.startsWith(sep));
}

function legacySelector(value: string): PathSelector {
  const expanded = expandHome(value);
  if (expanded.endsWith(`${sep}**`)) return tree(expanded.slice(0, -3) || sep);
  const components = expanded.split(sep);
  const index = components.findIndex((component) => /[*?\[\]{}]/.test(component));
  if (index < 0) return exact(expanded);
  const base = components.slice(0, index).join(sep) || sep;
  return glob(base, components.slice(index).join(sep));
}
