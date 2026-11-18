import type { SessionGrant } from "../../lib/session-grants.ts";
import type { NetworkAllowances } from "./profiles.ts";
import type { Settings } from "./settings.ts";
import { isRecord } from "../../lib/untyped.ts";

export const NETWORK_ENTRY_TYPE = "network-permissions";

export function serializeGrants(grants: NetworkGrants): { allow: string[]; deny: string[]; denyReasons: Record<string, string> } {
  const reasons = [...grants.deny].filter((entry): entry is [string, string] => entry[1] !== undefined);
  return { allow: [...grants.allow], deny: [...grants.deny.keys()], denyReasons: Object.fromEntries(reasons) };
}

// Session entries are parsed leniently: an entry without denyReasons has no reasons, and malformed
// values are dropped rather than failing the session.
export function parseGrants(value: unknown): NetworkGrants {
  if (!isRecord(value)) return emptyGrants();
  const { allow, deny, denyReasons } = value;
  const reasons = stringRecord(denyReasons);
  return { allow: new Set(strings(allow)), deny: new Map(strings(deny).map((pattern) => [pattern, reasons[pattern]])) };
}

export function emptyGrants(): NetworkGrants {
  return { allow: new Set(), deny: new Map() };
}

export function networkSessionGrants(grants: NetworkGrants): SessionGrant[] {
  return [
    ...[...grants.allow].sort().map((host) => ({ kind: "network", decision: "allow", host }) as const),
    ...[...grants.deny.keys()].sort().map((host) => ({ kind: "network", decision: "deny", host }) as const),
  ];
}

// The latest decision for a pattern wins, so granting one side revokes the other.
export function recordGrant(grants: NetworkGrants, decision: NetworkDecision, pattern: string, note: string | undefined): void {
  if (decision === "allow") {
    grants.allow.add(pattern);
    grants.deny.delete(pattern);
    return;
  }
  grants.deny.set(pattern, note);
  grants.allow.delete(pattern);
}

// The answer a prompt for host:port would repeat: session grants first, then a once-answer still held by a running command.
export function rememberedDecision(grants: NetworkGrants, once: OnceNetworkGrants, host: string, port: number | undefined): NetworkDecision | undefined {
  const keys = candidateKeys(host, port);
  if (keys.some((key) => grants.deny.has(key))) return "deny";
  if (keys.some((key) => grants.allow.has(key))) return "allow";
  return keys.map((key) => once.get(key)?.decision).find((decision) => decision !== undefined);
}

// srt asks once per connection and does not say which command opened it, so a once-answer holds until every
// command that was running when it was given has exited. With nothing running it covers only the asking request.
export function recordOnceGrant(once: OnceNetworkGrants, decision: NetworkDecision, pattern: string, running: ReadonlySet<number>, note: string | undefined): void {
  if (running.size === 0) return;
  once.set(pattern, { decision, holders: new Set(running), note });
}

// The reason the user gave for a denial of host:port: the once-answer of the running command first, then the session, then sandbox.json.
export function networkDenialNote({ grants, once, settingsReasons }: DenialNoteSources, host: string, port: number): string | undefined {
  const keys = candidateKeys(host, port);
  for (const key of keys) {
    const onceGrant = once.get(key);
    if (onceGrant?.decision === "deny" && onceGrant.note) return onceGrant.note;
  }
  for (const key of keys) {
    const note = grants.deny.get(key) ?? settingsReasons.get(key);
    if (note) return note;
  }
  return undefined;
}

export interface DenialNoteSources {
  grants: NetworkGrants;
  once: OnceNetworkGrants;
  settingsReasons: ReadonlyMap<string, string>;
}

export function releaseOnceGrants(once: OnceNetworkGrants, execution: number): void {
  for (const [host, grant] of once) {
    grant.holders.delete(execution);
    if (grant.holders.size === 0) once.delete(host);
  }
}

export type OnceNetworkGrants = Map<string, OnceNetworkGrant>;

export interface OnceNetworkGrant {
  decision: NetworkDecision;
  holders: Set<number>;
  note: string | undefined;
}

export type NetworkDecision = "allow" | "deny";

// Subagents get no network at all: an empty allowlist plus a deny-all entry, and no local sockets.
// Active profiles add their hosts and sockets; a session deny of the same host still wins, as it does over the settings file.
export function networkConfig(settings: Settings, grants: NetworkGrants, role: "subagent" | "main", profile: NetworkAllowances): NetworkConfig {
  if (role === "subagent") return { allowedDomains: [], deniedDomains: ["*"], allowUnixSockets: [], allowLocalBinding: false };
  const { allowedDomains, deniedDomains } = effectiveNetwork(settings, grants);
  const profileDomains = profile.allowedDomains.filter((host) => !grants.deny.has(host));
  return {
    allowedDomains: [...new Set([...allowedDomains, ...profileDomains])],
    deniedDomains,
    allowUnixSockets: [...new Set([...settings.allowUnixSockets, ...profile.allowUnixSockets])],
    allowLocalBinding: settings.allowLocalBinding || profile.allowLocalBinding,
  };
}

export interface NetworkConfig extends NetworkLists {
  allowUnixSockets: string[];
  allowLocalBinding: boolean;
}

export const NO_PROFILE_NETWORK: NetworkAllowances = { allowedDomains: [], allowLocalBinding: false, allowUnixSockets: [] };

// Session grants override the settings file: a session allow lifts a stored deny of the same host and vice versa.
export function effectiveNetwork(settings: Settings, grants: NetworkGrants): NetworkLists {
  const allowedDomains = [...settings.allowedDomains.filter((host) => !grants.deny.has(host)), ...grants.allow];
  const deniedDomains = [...settings.deniedDomains.filter((host) => !grants.allow.has(host)), ...grants.deny.keys()];
  return { allowedDomains: [...new Set(allowedDomains)], deniedDomains: [...new Set(deniedDomains)] };
}

export interface NetworkGrants {
  allow: Set<string>;
  // The value is the user's reason, repeated to the agent whenever the deny blocks a connection.
  deny: Map<string, string | undefined>;
}

export interface NetworkLists {
  allowedDomains: string[];
  deniedDomains: string[];
}

function candidateKeys(host: string, port: number | undefined): string[] {
  return port === undefined ? [host] : [destinationKey(host, port), host];
}

// srt requires brackets around an IPv6 literal that carries a port.
export function destinationKey(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
