import type { Settings } from "./settings.ts";

export const NETWORK_ENTRY_TYPE = "network-permissions";

export interface NetworkGrants {
  allow: Set<string>;
  deny: Set<string>;
}

export interface NetworkLists {
  allowedDomains: string[];
  deniedDomains: string[];
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
export function recordGrant(grants: NetworkGrants, decision: "allow" | "deny", host: string): void {
  const opposite = decision === "allow" ? "deny" : "allow";
  grants[decision].add(host);
  grants[opposite].delete(host);
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
