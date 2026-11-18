import { createHash } from "node:crypto";
import { errorMessage } from "../../lib/errors.ts";
import { shortenPath } from "../../lib/format.ts";
import type { AccessMode, PathSelector } from "../../lib/path-permission-rules.ts";
import { booleanValue, requireRecord, stringArray, unique } from "./settings-values.ts";

export const NetworkAccess = { Listed: "listed", Local: "local", All: "all" } as const;

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const PROFILE_NAME_RULE = "use lowercase letters, digits and dashes, starting with a letter or digit";

export function emptyProfileDefinition(): ProfileDefinition {
  return {
    triggers: { commands: [], patterns: [] },
    filesystem: { read: [], write: [] },
    network: { access: NetworkAccess.Listed, allowedDomains: [], allowLocalBinding: false, allowUnixSockets: [] },
    path: [],
  };
}

// Throws with the field's path inside the profile file, so a bad hand edit points at the entry.
export function parseProfileDefinition(value: unknown): ProfileDefinition {
  const root = requireRecord(value, "profile");
  const triggers = requireRecord(root.triggers ?? {}, "triggers");
  const filesystem = requireRecord(root.filesystem ?? {}, "filesystem");
  const network = requireRecord(root.network ?? {}, "network");
  return {
    triggers: {
      commands: stringArray(triggers.commands, "triggers.commands"),
      patterns: patternArray(triggers.patterns, "triggers.patterns"),
    },
    filesystem: {
      read: pathArray(filesystem.read, "filesystem.read"),
      write: pathArray(filesystem.write, "filesystem.write"),
    },
    network: {
      access: networkAccess(network.access, "network.access"),
      allowedDomains: stringArray(network.allowedDomains, "network.allowedDomains"),
      allowLocalBinding: booleanValue(network.allowLocalBinding, "network.allowLocalBinding"),
      allowUnixSockets: pathArray(network.allowUnixSockets, "network.allowUnixSockets"),
    },
    path: pathArray(root.path, "path"),
  };
}

export function isValidProfileName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

export function parseActivationDecisions(value: unknown): ActivationDecisions {
  if (value === undefined) return emptyActivationDecisions();
  const record = requireRecord(value, "profileActivation");
  const reasons = record.deniedReasons === undefined ? {} : requireRecord(record.deniedReasons, "profileActivation.deniedReasons");
  const denied = stringArray(record.denied, "profileActivation.denied");
  return {
    allowed: new Set(stringArray(record.allowed, "profileActivation.allowed")),
    denied: new Map(denied.map((name) => [name, typeof reasons[name] === "string" ? reasons[name] : undefined])),
  };
}

export function emptyActivationDecisions(): ActivationDecisions {
  return { allowed: new Set(), denied: new Map() };
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

export function forgetActivationDecision(decisions: ActivationDecisions, name: string): void {
  decisions.allowed.delete(name);
  decisions.denied.delete(name);
}

export function serializeActivationDecisions({ allowed, denied }: ActivationDecisions): { allowed: string[]; denied: string[]; deniedReasons: Record<string, string> } {
  const reasons = [...denied].filter((entry): entry is [string, string] => entry[1] !== undefined);
  return { allowed: [...allowed], denied: [...denied.keys()], deniedReasons: Object.fromEntries(reasons) };
}

// The "Allow always" and "Deny always" answers to activation prompts. They live in sandbox.json, never
// inside a profile file, the way network answers go to network.allowedDomains.
export interface ActivationDecisions {
  allowed: Set<string>;
  // The value is the user's reason, repeated to the agent whenever the denial applies.
  denied: Map<string, string | undefined>;
}

// Long enough that two profile sets never collide in practice, short enough for an environment variable.
const FINGERPRINT_LENGTH = 16;

// Triggers are left out on purpose: editing them never needs a restart of a long-lived server.
export function profileFingerprint(profiles: readonly Profile[]): string {
  if (profiles.length === 0) return "";
  const reduced = [...profiles]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ name, filesystem, network, path }) => ({ name, filesystem, network, path }));
  return createHash("sha256").update(JSON.stringify(reduced)).digest("hex").slice(0, FINGERPRINT_LENGTH);
}

// Patterns srt's proxy matches; its config schema rejects "*" and "*.localhost", but the manager does not validate them.
const LOOPBACK_HOSTS = ["localhost", "*.localhost", "127.0.0.1", "[::1]"];
const EVERY_HOST = "*";

export function mergedProfileNetwork(profiles: readonly Profile[]): NetworkAllowances {
  const networks = profiles.map(({ network }) => network);
  return {
    allowedDomains: unique(networks.flatMap(networkHosts)),
    allowLocalBinding: networks.some(({ access, allowLocalBinding }) => allowLocalBinding || access !== NetworkAccess.Listed),
    allowUnixSockets: unique(networks.flatMap(({ allowUnixSockets }) => allowUnixSockets)),
  };
}

export interface Profile extends ProfileDefinition {
  name: string;
}

function networkHosts({ access, allowedDomains }: ProfileNetwork): string[] {
  switch (access) {
    case NetworkAccess.Listed: return allowedDomains;
    case NetworkAccess.Local: return [...allowedDomains, ...LOOPBACK_HOSTS];
    case NetworkAccess.All: return [...allowedDomains, ...LOOPBACK_HOSTS, EVERY_HOST];
  }
}

export function selectorText(selector: PathSelector, homeDirectory: string): string {
  switch (selector.kind) {
    case "tree": return shortenPath(`${selector.path}/**`, homeDirectory);
    case "exact": return shortenPath(selector.path, homeDirectory);
    case "glob": return shortenPath(`${selector.base}/${selector.pattern}`, homeDirectory);
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

export interface ProfileDefinition {
  triggers: ProfileTriggers;
  filesystem: { read: string[]; write: string[] };
  network: ProfileNetwork;
  path: string[];
}

export interface ProfileTriggers {
  commands: string[];
  patterns: string[];
}

export interface ProfileNetwork extends NetworkAllowances {
  access: NetworkAccess;
}

// What srt's network config takes from profiles.
export interface NetworkAllowances {
  allowedDomains: string[];
  allowLocalBinding: boolean;
  allowUnixSockets: string[];
}

function pathArray(value: unknown, name: string): string[] {
  const entries = stringArray(value, name);
  for (const [index, entry] of entries.entries()) {
    if (!entry.startsWith("/") && !entry.startsWith("~/")) throw new Error(`${name}[${index}] must start with / or ~/`);
  }
  return entries;
}

function patternArray(value: unknown, name: string): string[] {
  const patterns = stringArray(value, name);
  for (const [index, pattern] of patterns.entries()) {
    try {
      new RegExp(pattern);
    } catch (error) {
      throw new Error(`${name}[${index}] is not a valid regular expression: ${errorMessage(error)}`, { cause: error });
    }
  }
  return patterns;
}

function networkAccess(value: unknown, name: string): NetworkAccess {
  if (value === undefined) return NetworkAccess.Listed;
  const level = Object.values(NetworkAccess).find((candidate) => candidate === value);
  if (level === undefined) throw new Error(`${name} must be one of ${Object.values(NetworkAccess).map((candidate) => `"${candidate}"`).join(", ")}`);
  return level;
}
export type NetworkAccess = (typeof NetworkAccess)[keyof typeof NetworkAccess];
