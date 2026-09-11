import { homedir } from "node:os";
import { join, matchesGlob, resolve, sep } from "node:path";
import { expandHome } from "./path-resolution.ts";

export type AccessMode = "read" | "write";
export type RuleKind = "allow" | "deny";
export type RuleTier = "session" | "always";
export type Verdict = "allow" | "deny" | "prompt";

export interface PathRule {
  mode: AccessMode;
  kind: RuleKind;
  tier: RuleTier;
  pattern: string;
}

export interface RuleSets {
  read: {
    allow: Set<string>;
    deny: Set<string>;
  };
  write: {
    allow: Set<string>;
    deny: Set<string>;
  };
}

export interface SerializedRules {
  read: {
    allow: string[];
    deny: string[];
  };
  write: {
    allow: string[];
    deny: string[];
  };
}

export interface DefaultAllowedOptions {
  planMode: boolean;
  repoRoot: string;
  memoryDirectory: string;
  planPath: string | undefined;
  skillRoots: string[];
  agentDirectory: string;
}

export interface RuleTiers {
  session: RuleSets;
  always: RuleSets;
}

export function emptyRules(): RuleSets {
  return {
    read: { allow: new Set(), deny: new Set() },
    write: { allow: new Set(), deny: new Set() },
  };
}

export function serializeRules(rules: RuleSets): SerializedRules {
  return {
    read: {
      allow: [...rules.read.allow].sort(),
      deny: [...rules.read.deny].sort(),
    },
    write: {
      allow: [...rules.write.allow].sort(),
      deny: [...rules.write.deny].sort(),
    },
  };
}

export function parseRules(value: unknown): RuleSets {
  if (!value || typeof value !== "object") return emptyRules();

  const { read, write } = value as { read?: unknown; write?: unknown };
  return {
    read: parseModeRules(read),
    write: parseModeRules(write),
  };
}

export function hasSerializedRuleKeys(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return "read" in value || "write" in value;
}

// Plain paths are exact. Directory subtrees are explicitly written as "<dir>/**";
// that form also covers the directory itself so listing it needs no second rule.
export function matchesRule(resolvedPath: string, pattern: string): boolean {
  const anchored = resolve(expandHome(pattern));
  if (!hasGlobCharacters(pattern)) return resolvedPath === anchored;

  const suffix = `${sep}**`;
  const subtreeRoot = anchored.endsWith(suffix)
    ? anchored.slice(0, -suffix.length) || sep
    : undefined;
  if (subtreeRoot !== undefined && resolvedPath === subtreeRoot) return true;
  return matchesGlob(resolvedPath, anchored);
}


export function evaluate(
  resolvedPath: string,
  mode: AccessMode,
  layers: {
    defaults: Iterable<string>;
    always: RuleSets;
    session: RuleSets;
  },
): Verdict {
  const { defaults, always, session } = layers;
  if (
    matchesAny(resolvedPath, always[mode].deny) ||
    matchesAny(resolvedPath, session[mode].deny)
  ) {
    return "deny";
  }
  if (
    matchesAny(resolvedPath, defaults) ||
    matchesAny(resolvedPath, always[mode].allow) ||
    matchesAny(resolvedPath, session[mode].allow)
  ) {
    return "allow";
  }
  return "prompt";
}

export function defaultAllowed(
  mode: AccessMode,
  options: DefaultAllowedOptions,
): string[] {
  const {
    planMode,
    repoRoot,
    memoryDirectory,
    planPath,
    skillRoots,
    agentDirectory,
  } = options;
  const scratch = [
    subtree(memoryDirectory),
    ...(planPath === undefined ? [] : [planPath]),
  ];
  if (mode === "read") {
    return [
      subtree(repoRoot),
      ...scratch,
      subtree(join(homedir(), ".crit")),
      subtree(join(agentDirectory, "plans")),
      ...skillRoots.map(subtree),
    ];
  }
  return planMode ? scratch : [subtree(repoRoot), ...scratch];
}

export function subtree(directory: string): string {
  return join(directory, "**");
}

export function recordRule(
  rule: PathRule,
  tiers: RuleTiers,
): Set<RuleTier> {
  const changed = new Set<RuleTier>([rule.tier]);
  const opposite = rule.kind === "allow" ? "deny" : "allow";
  const otherTier = rule.tier === "session" ? "always" : "session";
  tiers[rule.tier][rule.mode][rule.kind].add(rule.pattern);
  tiers[rule.tier][rule.mode][opposite].delete(rule.pattern);
  if (tiers[otherTier][rule.mode][opposite].delete(rule.pattern)) {
    changed.add(otherTier);
  }
  return changed;
}

function parseModeRules(value: unknown): RuleSets[AccessMode] {
  if (!value || typeof value !== "object") {
    return { allow: new Set(), deny: new Set() };
  }
  const { allow, deny } = value as { allow?: unknown; deny?: unknown };
  return {
    allow: new Set(stringList(allow)),
    deny: new Set(stringList(deny)),
  };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function hasGlobCharacters(pattern: string): boolean {
  return /[*?[\]{}]/.test(pattern);
}

function matchesAny(path: string, patterns: Iterable<string>): boolean {
  for (const pattern of patterns) {
    if (matchesRule(path, pattern)) return true;
  }
  return false;
}

