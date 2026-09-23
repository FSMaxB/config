import { homedir } from "node:os";
import { join, matchesGlob, relative, sep } from "node:path";


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
  selector: PathSelector;
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
  if (record.version !== 2) throw new Error(`Unsupported path permission rules version: ${String(record.version)}`);
  const read = parseModeRules(record.read), write = parseModeRules(record.write);
  if (!read || !write) throw new Error("Invalid path permission rules");
  return { read, write };
}

export function matchesRule(resolvedPath: string, selector: PathSelector): boolean {
  if (selector.kind === "exact") return resolvedPath === selector.path;
  if (selector.kind === "tree") return contains(selector.path, resolvedPath);
  return contains(selector.base, resolvedPath) && matchesGlob(relative(selector.base, resolvedPath), selector.pattern);
}

export function evaluate(resolvedPath: string, mode: AccessMode, layers: { defaults: Iterable<PathSelector>; always: RuleSets; session: RuleSets }): Verdict {
  const { defaults, always, session } = layers;
  if (matchesAny(resolvedPath, always[mode].deny) || matchesAny(resolvedPath, session[mode].deny)) return "deny";
  if (matchesAny(resolvedPath, defaults) || matchesAny(resolvedPath, always[mode].allow) || matchesAny(resolvedPath, session[mode].allow)) return "allow";
  return "prompt";
}

export function defaultAllowed(mode: AccessMode, options: DefaultAllowedOptions): PathSelector[] {
  const { planMode, repoRoot, memoryDirectory, skillRoots, agentDirectory } = options;
  const scratch = [tree(memoryDirectory), tree(join(agentDirectory, "plans"))];
  if (mode === "read") return [tree(repoRoot), ...scratch, tree(join(homedir(), ".crit")), ...skillRoots.map(tree)];
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
  const key = selectorKey(rule.selector);
  tiers[rule.tier][rule.mode][rule.kind].add(key);
  tiers[rule.tier][rule.mode][opposite].delete(key);
  if (tiers[otherTier][rule.mode][opposite].delete(key)) changed.add(otherTier);
  return changed;
}

export function selectorFromKey(key: string): PathSelector {
  const [kind, first, second] = JSON.parse(key) as [PathSelector["kind"], string, string?];
  return kind === "glob" ? glob(first, second ?? "") : { kind, path: first };
}

function selectors(values: Set<string>): PathSelector[] {
  return [...values].map(selectorFromKey).sort((left, right) => selectorKey(left).localeCompare(selectorKey(right)));
}
function parseModeRules(value: unknown): RuleSets[AccessMode] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { allow, deny } = value as Record<string, unknown>;
  if (!Array.isArray(allow) || !Array.isArray(deny)) return undefined;
  const allowed = allow.map(normalizeSelector), denied = deny.map(normalizeSelector);
  if (!allowed.every(isDefined) || !denied.every(isDefined)) return undefined;
  return { allow: new Set(allowed.map(selectorKey)), deny: new Set(denied.map(selectorKey)) };
}
function normalizeSelector(value: unknown): PathSelector | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { kind, path, base, pattern } = value as Record<string, unknown>;
  if (kind === "glob") return typeof base === "string" && typeof pattern === "string" ? glob(base, pattern) : undefined;
  return (kind === "exact" || kind === "tree") && typeof path === "string" ? pathSelector(kind, path) : undefined;
}
// A tree already covers its whole subtree, so a stored trailing "/**" is redundant and would
// otherwise only match a directory literally named "**".
function pathSelector(kind: "exact" | "tree", path: string): PathSelector {
  return kind === "tree" && path.endsWith(`${sep}**`) ? tree(path.slice(0, -3) || sep) : { kind, path };
}
function isDefined<T>(value: T | undefined): value is T { return value !== undefined; }
function matchesAny(path: string, selectorsOrKeys: Iterable<string | PathSelector>): boolean {
  for (const value of selectorsOrKeys) {
    if (matchesRule(path, typeof value === "string" ? selectorFromKey(value) : value)) return true;
  }
  return false;
}

function contains(root: string, path: string): boolean {
  const remainder = relative(root, path);
  return remainder === "" || (!remainder.startsWith(`..${sep}`) && remainder !== ".." && !remainder.startsWith(sep));
}

