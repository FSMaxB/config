import { shortenPath } from "../lib/format.ts";
import type { SessionGrant } from "../lib/session-grants.ts";

const KIND_ORDER: readonly SessionGrant["kind"][] = ["path", "tool", "network", "profile", "unsandboxed"];

/** One row per grant, grouped by kind in a fixed order; providers already sort within a kind. */
export function grantRows(grants: readonly SessionGrant[], homeDirectory: string): string[] {
  return [...grants]
    .sort((left, right) => KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind))
    .map((grant) => `${grant.decision === "allow" ? "✓" : "✗"} ${subject(grant, homeDirectory)}`);
}

function subject(grant: SessionGrant, homeDirectory: string): string {
  switch (grant.kind) {
    case "path":
      return `${grant.access} ${shortenPath(grant.target, homeDirectory)}`;
    case "tool":
      return `tool ${grant.name}`;
    case "network":
      return `net ${grant.host}`;
    case "profile":
      return `profile ${grant.name}`;
    case "unsandboxed":
      return "unsandboxed bash";
  }
}
