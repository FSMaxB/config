import { createHash } from "node:crypto";
import type { AccessMode, PathSelector } from "../../lib/path-permission-rules.ts";

export interface ProfileTriggers {
  commands: string[];
  patterns: string[];
}

export interface ProfileNetwork {
  allowedDomains: string[];
  allowLocalBinding: boolean;
  allowUnixSockets: string[];
}

export interface ProfileDefinition {
  triggers: ProfileTriggers;
  filesystem: { read: string[]; write: string[] };
  network: ProfileNetwork;
  path: string[];
}

export interface Profile extends ProfileDefinition {
  name: string;
}

// The "Allow always" and "Deny always" answers to activation prompts. They live next to the profiles in
// sandbox.json, never inside one, the way network answers go to network.allowedDomains.
export interface ActivationDecisions {
  allowed: Set<string>;
  // The value is the user's reason, repeated to the agent whenever the denial applies.
  denied: Map<string, string | undefined>;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function emptyProfileDefinition(): ProfileDefinition {
  return {
    triggers: { commands: [], patterns: [] },
    filesystem: { read: [], write: [] },
    network: { allowedDomains: [], allowLocalBinding: false, allowUnixSockets: [] },
    path: [],
  };
}

export function emptyActivationDecisions(): ActivationDecisions {
  return { allowed: new Set(), denied: new Map() };
}

export function isValidProfileName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

export function parseProfiles(value: unknown): Profile[] {
  if (value === undefined) return [];
  const record = asRecord(value, "profiles");
  return Object.keys(record)
    .sort()
    .map((name) => ({ name, ...parseProfileDefinition(record[name], name) }));
}

// Throws with the profile name in the message, so a bad hand edit points at its profile.
export function parseProfileDefinition(value: unknown, name: string): ProfileDefinition {
  if (!isValidProfileName(name)) throw new Error(`profiles.${name}: the name must match ${NAME_PATTERN}`);
  const prefix = `profiles.${name}`;
  const root = asRecord(value, prefix);
  const triggers = asRecord(root.triggers ?? {}, `${prefix}.triggers`);
  const filesystem = asRecord(root.filesystem ?? {}, `${prefix}.filesystem`);
  const network = asRecord(root.network ?? {}, `${prefix}.network`);
  return {
    triggers: {
      commands: stringArray(triggers.commands, `${prefix}.triggers.commands`),
      patterns: patternArray(triggers.patterns, `${prefix}.triggers.patterns`),
    },
    filesystem: {
      read: pathArray(filesystem.read, `${prefix}.filesystem.read`),
      write: pathArray(filesystem.write, `${prefix}.filesystem.write`),
    },
    network: {
      allowedDomains: stringArray(network.allowedDomains, `${prefix}.network.allowedDomains`),
      allowLocalBinding: boolean(network.allowLocalBinding, `${prefix}.network.allowLocalBinding`),
      allowUnixSockets: pathArray(network.allowUnixSockets, `${prefix}.network.allowUnixSockets`),
    },
    path: pathArray(root.path, `${prefix}.path`),
  };
}

export function parseActivationDecisions(value: unknown): ActivationDecisions {
  if (value === undefined) return emptyActivationDecisions();
  const record = asRecord(value, "profileActivation");
  const reasons = record.deniedReasons === undefined ? {} : asRecord(record.deniedReasons, "profileActivation.deniedReasons");
  const denied = stringArray(record.denied, "profileActivation.denied");
  return {
    allowed: new Set(stringArray(record.allowed, "profileActivation.allowed")),
    denied: new Map(denied.map((name) => [name, typeof reasons[name] === "string" ? reasons[name] : undefined])),
  };
}

// The latest answer for a name wins, so recording one side removes the other.
export function recordActivationDecision(decisions: ActivationDecisions, name: string, decision: { decision: "allow" } | { decision: "deny"; note: string | undefined }): void {
  if (decision.decision === "allow") {
    decisions.allowed.add(name);
    decisions.denied.delete(name);
    return;
  }
  decisions.denied.set(name, decision.note);
  decisions.allowed.delete(name);
}

export function serializeActivationDecisions({ allowed, denied }: ActivationDecisions): { allowed: string[]; denied: string[]; deniedReasons: Record<string, string> } {
  const reasons = [...denied].filter((entry): entry is [string, string] => entry[1] !== undefined);
  return { allowed: [...allowed], denied: [...denied.keys()], deniedReasons: Object.fromEntries(reasons) };
}

// Triggers are left out on purpose: editing them never needs a restart of a long-lived server.
export function profileFingerprint(profiles: readonly Profile[]): string {
  if (profiles.length === 0) return "";
  const reduced = [...profiles]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ name, filesystem, network, path }) => ({ name, filesystem, network, path }));
  return createHash("sha256").update(JSON.stringify(reduced)).digest("hex").slice(0, 16);
}

export function mergedProfileNetwork(profiles: readonly Profile[]): ProfileNetwork {
  return {
    allowedDomains: unique(profiles.flatMap(({ network }) => network.allowedDomains)),
    allowLocalBinding: profiles.some(({ network }) => network.allowLocalBinding),
    allowUnixSockets: unique(profiles.flatMap(({ network }) => network.allowUnixSockets)),
  };
}

export function selectorText(selector: PathSelector, homeDirectory: string): string {
  switch (selector.kind) {
    case "tree": return withTilde(`${selector.path}/**`, homeDirectory);
    case "exact": return withTilde(selector.path, homeDirectory);
    case "glob": return withTilde(`${selector.base}/${selector.pattern}`, homeDirectory);
  }
}

export function addFilesystemEntry(definition: ProfileDefinition, mode: AccessMode, entry: string): ProfileDefinition {
  const entries = definition.filesystem[mode];
  if (entries.includes(entry)) return definition;
  return { ...definition, filesystem: { ...definition.filesystem, [mode]: [...entries, entry] } };
}

export function addAllowedDomain(definition: ProfileDefinition, domain: string): ProfileDefinition {
  if (definition.network.allowedDomains.includes(domain)) return definition;
  return { ...definition, network: { ...definition.network, allowedDomains: [...definition.network.allowedDomains, domain] } };
}

function withTilde(text: string, homeDirectory: string): string {
  if (text === homeDirectory) return "~";
  return text.startsWith(`${homeDirectory}/`) ? `~${text.slice(homeDirectory.length)}` : text;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) throw new Error(`${name} must be an array of strings`);
  return value;
}

function pathArray(value: unknown, name: string): string[] {
  const entries = stringArray(value, name);
  entries.forEach((entry, index) => {
    if (!entry.startsWith("/") && !entry.startsWith("~/")) throw new Error(`${name}[${index}] must start with / or ~/`);
  });
  return entries;
}

function patternArray(value: unknown, name: string): string[] {
  const patterns = stringArray(value, name);
  patterns.forEach((pattern, index) => {
    try {
      new RegExp(pattern);
    } catch (error) {
      throw new Error(`${name}[${index}] is not a valid regular expression: ${(error as Error).message}`);
    }
  });
  return patterns;
}

function boolean(value: unknown, name: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
