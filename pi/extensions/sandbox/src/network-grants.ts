import type { Settings } from "./settings.ts";

export const NETWORK_ENTRY_TYPE = "network-permissions";

export interface NetworkGrants {
  allow: Set<string>;
  deny: Set<string>;
}

export type NetworkDecision = "allow" | "deny";

export interface OnceNetworkGrant {
  decision: NetworkDecision;
  holders: Set<number>;
}

export type OnceNetworkGrants = Map<string, OnceNetworkGrant>;

export interface NetworkLists {
  allowedDomains: string[];
  deniedDomains: string[];
}

export interface NetworkConfig extends NetworkLists {
  allowUnixSockets: string[];
  allowLocalBinding: boolean;
}

export function emptyGrants(): NetworkGrants {
  return { allow: new Set(), deny: new Set() };
}

export function serializeGrants(grants: NetworkGrants): { allow: string[]; deny: string[] } {
  return { allow: [...grants.allow], deny: [...grants.deny] };
}

export function parseGrants(value: unknown): NetworkGrants {
  if (typeof value !== "object" || value === null) return emptyGrants();
  const { allow, deny } = value as { allow?: unknown; deny?: unknown };
  return { allow: new Set(strings(allow)), deny: new Set(strings(deny)) };
}

// The latest decision for a host wins, so granting one side revokes the other.
export function recordGrant(grants: NetworkGrants, decision: NetworkDecision, host: string): void {
  const opposite = decision === "allow" ? "deny" : "allow";
  grants[decision].add(host);
  grants[opposite].delete(host);
}

// The answer a prompt for host would repeat: session grants first, then a once-answer still held by a running command.
export function rememberedDecision(grants: NetworkGrants, once: OnceNetworkGrants, host: string): NetworkDecision | undefined {
  if (grants.deny.has(host)) return "deny";
  if (grants.allow.has(host)) return "allow";
  return once.get(host)?.decision;
}

// srt asks once per connection and does not say which command opened it, so a once-answer holds until every
// command that was running when it was given has exited. With nothing running it covers only the asking request.
export function recordOnceGrant(once: OnceNetworkGrants, decision: NetworkDecision, host: string, running: ReadonlySet<number>): void {
  if (running.size === 0) return;
  once.set(host, { decision, holders: new Set(running) });
}

export function releaseOnceGrants(once: OnceNetworkGrants, execution: number): void {
  for (const [host, grant] of once) {
    grant.holders.delete(execution);
    if (grant.holders.size === 0) once.delete(host);
  }
}

// Subagents get no network at all: an empty allowlist plus a deny-all entry, and no local sockets.
export function networkConfig(settings: Settings, grants: NetworkGrants, subagent: boolean): NetworkConfig {
  if (subagent) return { allowedDomains: [], deniedDomains: ["*"], allowUnixSockets: [], allowLocalBinding: false };
  return { ...effectiveNetwork(settings, grants), allowUnixSockets: settings.allowUnixSockets, allowLocalBinding: settings.allowLocalBinding };
}

// Session grants override the settings file: a session allow lifts a stored deny of the same host and vice versa.
export function effectiveNetwork(settings: Settings, grants: NetworkGrants): NetworkLists {
  const allowedDomains = [...settings.allowedDomains.filter((host) => !grants.deny.has(host)), ...grants.allow];
  const deniedDomains = [...settings.deniedDomains.filter((host) => !grants.allow.has(host)), ...grants.deny];
  return { allowedDomains: [...new Set(allowedDomains)], deniedDomains: [...new Set(deniedDomains)] };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
