import { homedir } from "node:os";
import { dirname, join, matchesGlob, relative, sep } from "node:path";
import { AgentMode, isRestricted, PathRuleStore } from "./agent-mode.ts";
import { contains } from "./repo.ts";
import type { SessionGrant } from "./session-grants.ts";


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
  // Deny rules only: the user's reason, repeated to the agent on every denial the rule causes.
  note?: string;
}

export interface ModeRules {
  allow: Set<string>;
  // Keyed by selectorKey like allow; the value is the deny rule's note.
  deny: Map<string, string | undefined>;
}

export interface RuleSets {
  read: ModeRules;
  write: ModeRules;
}

export type DenyEntry = PathSelector & { note?: string };

export interface SerializedRuleSets {
  read: { allow: PathSelector[]; deny: DenyEntry[] };
  write: { allow: PathSelector[]; deny: DenyEntry[] };
}

export const EntryKind = { File: "file", Directory: "directory" } as const;
export type EntryKind = (typeof EntryKind)[keyof typeof EntryKind];

// One mode's rules, as the subagent path policy carries them.
export interface SerializedRules extends SerializedRuleSets { version: 2 }

export type StoredRules = Record<PathRuleStore, RuleSets>;

// Every mode's rules, as the rules file and the session entry hold them.
export type SerializedStoredRules = { version: 3 } & Record<PathRuleStore, SerializedRuleSets>;

export interface DefaultAllowedOptions {
  agentMode: AgentMode;
  repoRoot: string;
  memoryDirectory: string;
  skillRoots: string[];
  agentDirectory: string;
  temporaryDirectory?: string;
}

export interface RuleTiers { session: RuleSets; always: RuleSets }

export function emptyRules(): RuleSets {
  return { read: { allow: new Set(), deny: new Map() }, write: { allow: new Set(), deny: new Map() } };
}

export function emptyStoredRules(): StoredRules {
  return { [PathRuleStore.Execution]: emptyRules(), [PathRuleStore.Plan]: emptyRules(), [PathRuleStore.Explore]: emptyRules() };
}

export function selectorKey(selector: PathSelector): string {
  return selector.kind === "glob"
    ? JSON.stringify([selector.kind, selector.base, selector.pattern])
    : JSON.stringify([selector.kind, selector.path]);
}

export function selectorLabel(selector: PathSelector): string {
  return selector.kind === "exact" ? selector.path : selector.kind === "tree" ? `${selector.path}${sep}**` : `${selector.base}${sep}${selector.pattern}`;
}

export function serializeStoredRules(rules: StoredRules): SerializedStoredRules {
  return {
    version: 3,
    [PathRuleStore.Execution]: serializeRuleSets(rules[PathRuleStore.Execution]),
    [PathRuleStore.Plan]: serializeRuleSets(rules[PathRuleStore.Plan]),
    [PathRuleStore.Explore]: serializeRuleSets(rules[PathRuleStore.Explore]),
  };
}

export function parseStoredRules(value: unknown): StoredRules {
  const record = asRecord(value);
  if (record.version !== 3) throw new Error(`Unsupported path permission rules version: ${String(record.version)}`);
  const rules = emptyStoredRules();
  for (const store of Object.values(PathRuleStore)) rules[store] = parseRuleSets(record[store]);
  return rules;
}

export function serializeRules(rules: RuleSets): SerializedRules {
  return { version: 2, ...serializeRuleSets(rules) };
}

export function parseRules(value: unknown): RuleSets {
  const record = asRecord(value);
  if (record.version !== 2) throw new Error(`Unsupported path permission rules version: ${String(record.version)}`);
  return parseRuleSets(record);
}

export function sessionGrantsFromRules(rules: RuleSets): SessionGrant[] {
  return (["read", "write"] as const).flatMap((access) =>
    (["allow", "deny"] as const).flatMap((decision) =>
      [...rules[access][decision].keys()].sort().map((key) => ({ kind: "path", decision, access, target: selectorLabel(selectorFromKey(key)) }) as const),
    ),
  );
}

export function matchesRule(resolvedPath: string, selector: PathSelector): boolean {
  if (selector.kind === "exact") return resolvedPath === selector.path;
  if (selector.kind === "tree") return contains(selector.path, resolvedPath);
  return contains(selector.base, resolvedPath) && matchesGlob(relative(selector.base, resolvedPath), selector.pattern);
}

export interface PolicyLayers { defaults: Iterable<PathSelector>; always: RuleSets; session: RuleSets; protected?: Iterable<PathSelector> }

// Explicit grants beat protection, protection beats defaults.
export function evaluate(resolvedPath: string, mode: AccessMode, layers: PolicyLayers): Verdict {
  const { defaults, always, session, protected: protectedSelectors = [] } = layers;
  if (matchesAny(resolvedPath, always[mode].deny.keys()) || matchesAny(resolvedPath, session[mode].deny.keys())) return "deny";
  if (matchesAny(resolvedPath, always[mode].allow) || matchesAny(resolvedPath, session[mode].allow)) return "allow";
  if (matchesAny(resolvedPath, protectedSelectors)) return "prompt";
  if (matchesAny(resolvedPath, defaults)) return "allow";
  return "prompt";
}

// The reason of a deny rule that blocks the path; evaluate checks "always" before "session" as well.
export function denyNote(resolvedPath: string, mode: AccessMode, { always, session }: Pick<PolicyLayers, "always" | "session">): string | undefined {
  for (const [key, note] of [...always[mode].deny, ...session[mode].deny]) {
    if (note && matchesRule(resolvedPath, selectorFromKey(key))) return note;
  }
  return undefined;
}

// A tree or exact grant covers a protected selector rooted inside it. Glob grants never cover.
export function covers(grant: PathSelector, target: PathSelector): boolean {
  if (grant.kind === "glob") return false;
  const targetRoot = target.kind === "glob" ? target.base : target.path;
  return grant.kind === "tree" ? contains(grant.path, targetRoot) : grant.path === targetRoot;
}

// Protected selectors a grant would swallow, so the prompt can warn about them.
export function coveredProtectedSelectors(grant: PathSelector, protectedSelectors: Iterable<PathSelector>): PathSelector[] {
  return [...protectedSelectors].filter((target) => covers(grant, target));
}

// Narrowest first: the path itself, then each enclosing directory that still lies strictly inside the broad grant.
export function narrowerSelectors(resolvedPath: string, entry: EntryKind, broad: PathSelector): PathSelector[] {
  const own = entry === EntryKind.Directory ? tree(resolvedPath) : exact(resolvedPath);
  return [own, ...ancestorTrees(resolvedPath)].filter((candidate) => isStrictlyInside(candidate, broad));
}

export function defaultAllowed(mode: AccessMode, options: DefaultAllowedOptions): PathSelector[] {
  const { agentMode, repoRoot, memoryDirectory, skillRoots, agentDirectory, temporaryDirectory } = options;
  const scratch = [tree(memoryDirectory), tree(join(agentDirectory, "plans")), ...(temporaryDirectory ? [tree(temporaryDirectory)] : [])];
  if (mode === "read") return [tree(repoRoot), ...scratch, tree(join(homedir(), ".crit")), ...skillRoots.map(tree)];
  // Even read-only jj commands take these locks to snapshot the working copy and import from a colocated git repository.
  const jjLocks = [join(".jj", "working_copy", "working_copy.lock"), join(".jj", "repo", "git_import_export.lock")].map((lock) => exact(join(repoRoot, lock)));
  return isRestricted(agentMode) ? [...scratch, ...jjLocks] : [tree(repoRoot), ...scratch];
}

// Restricted modes drop the repository from the default write allows, so a write failure names it as the likely cause.
export function readOnlyRepositoryNotice(mode: AccessMode, agentMode: AgentMode): string {
  if (mode !== "write") return "";
  if (agentMode === AgentMode.Planning) return " Plan mode is on, so the repository is read-only until the user approves a plan.";
  if (agentMode === AgentMode.Exploring) return " Explore mode is on, so the repository is read-only until the user leaves it.";
  return "";
}

export function exact(path: string): PathSelector { return { kind: "exact", path }; }
export function tree(path: string): PathSelector { return { kind: "tree", path }; }
export function glob(base: string, pattern: string): PathSelector { return { kind: "glob", base, pattern }; }

export function recordRule(rule: PathRule, tiers: RuleTiers): Set<RuleTier> {
  const changed = new Set<RuleTier>([rule.tier]);
  const opposite = rule.kind === "allow" ? "deny" : "allow";
  const otherTier = rule.tier === "session" ? "always" : "session";
  const key = selectorKey(rule.selector);
  const modeRules = tiers[rule.tier][rule.mode];
  if (rule.kind === "allow") modeRules.allow.add(key);
  else modeRules.deny.set(key, rule.note);
  modeRules[opposite].delete(key);
  if (tiers[otherTier][rule.mode][opposite].delete(key)) changed.add(otherTier);
  return changed;
}

export function selectorFromKey(key: string): PathSelector {
  const [kind, first, second] = JSON.parse(key) as [PathSelector["kind"], string, string?];
  return kind === "glob" ? glob(first, second ?? "") : { kind, path: first };
}

function serializeRuleSets(rules: RuleSets): SerializedRuleSets {
  return {
    read: { allow: selectors(rules.read.allow), deny: denyEntries(rules.read.deny) },
    write: { allow: selectors(rules.write.allow), deny: denyEntries(rules.write.deny) },
  };
}
function parseRuleSets(value: unknown): RuleSets {
  const record = asRecord(value);
  const read = parseModeRules(record.read), write = parseModeRules(record.write);
  if (!read || !write) throw new Error("Invalid path permission rules");
  return { read, write };
}
function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("Invalid path permission rules");
  return value as Record<string, unknown>;
}
function selectors(values: Iterable<string>): PathSelector[] {
  return [...values].map(selectorFromKey).sort((left, right) => selectorKey(left).localeCompare(selectorKey(right)));
}
function denyEntries(values: Map<string, string | undefined>): DenyEntry[] {
  return selectors(values.keys()).map((selector) => {
    const note = values.get(selectorKey(selector));
    return note ? { ...selector, note } : selector;
  });
}
function ancestorTrees(path: string): PathSelector[] {
  const trees: PathSelector[] = [];
  for (let directory = dirname(path); directory !== dirname(directory); directory = dirname(directory)) trees.push(tree(directory));
  return trees;
}
// A glob grant (the protected agentDir/*.json) only narrows to the path itself; an enclosing tree would be broader.
function isStrictlyInside(candidate: PathSelector, broad: PathSelector): boolean {
  if (selectorKey(candidate) === selectorKey(broad)) return false;
  if (broad.kind === "tree") return covers(broad, candidate);
  return candidate.kind === "exact" && matchesRule(candidate.path, broad);
}
function parseModeRules(value: unknown): RuleSets[AccessMode] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { allow, deny } = value as Record<string, unknown>;
  if (!Array.isArray(allow) || !Array.isArray(deny)) return undefined;
  const allowed = allow.map(normalizeSelector), denied = deny.map(normalizeDenyEntry);
  if (!allowed.every(isDefined) || !denied.every(isDefined)) return undefined;
  return { allow: new Set(allowed.map(selectorKey)), deny: new Map(denied.map(({ selector, note }) => [selectorKey(selector), note])) };
}
function normalizeDenyEntry(value: unknown): { selector: PathSelector; note: string | undefined } | undefined {
  const selector = normalizeSelector(value);
  if (!selector) return undefined;
  const { note } = value as Record<string, unknown>;
  return { selector, note: typeof note === "string" && note !== "" ? note : undefined };
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

