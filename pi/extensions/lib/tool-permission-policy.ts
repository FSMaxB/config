import { realpathSync } from "node:fs";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";

export function planToolPermission(
  name: string,
  decisions: ToolDecisions,
  specialAllowedNames: ReadonlySet<string>,
  trustedReadOnlyNames: ReadonlySet<string>,
): ToolPermission {
  if (hasName(decisions.sessionDenials, name) || hasName(decisions.alwaysDenials, name)) return "deny";
  if (specialAllowedNames.has(name) || trustedReadOnlyNames.has(name) ||
      hasName(decisions.sessionGrants, name) || hasName(decisions.alwaysGrants, name)) return "allow";
  return "approval";
}

// Canonical paths let the installed extension symlink share ownership with this repository.
// Resolve every current registration: a later name override must not inherit earlier trust.
export function trustedReadOnlyToolNames(tools: readonly ToolPolicyInfo[]): Set<string> {
  const owners = new Map<string, ReadonlySet<string>>();
  for (const [file, names] of [
    ["files.ts", ["read", "ls", "find", "grep"]],
    ["vcs.ts", ["vcs_info", "vcs_status", "vcs_branches", "vcs_log", "vcs_show", "vcs_diff", "vcs_file", "vcs_blame"]],
    ["crit.ts", ["crit_comments", "crit_status"]],
  ] as const) {
    const path = canonicalPath(new URL(`../${file}`, import.meta.url));
    if (path) owners.set(path, new Set(names));
  }
  return new Set(tools.filter(tool => isTrustedReadOnlyRegistration({
    name: tool.name,
    readOnlyHint: tool.annotations?.readOnlyHint,
    ownerPath: canonicalPath(tool.sourceInfo?.path),
  }, owners)).map(tool => tool.name));
}

export function isTrustedReadOnlyRegistration(
  tool: { name: string; readOnlyHint?: boolean; ownerPath?: string },
  owners: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  return tool.readOnlyHint === true && tool.ownerPath !== undefined &&
    owners.get(tool.ownerPath)?.has(tool.name) === true;
}

function hasName(names: Iterable<string>, name: string): boolean {
  for (const candidate of names) if (candidate === name) return true;
  return false;
}

function canonicalPath(path: string | URL | undefined): string | undefined {
  if (path === undefined) return undefined;
  if (typeof path === "string" && (path.startsWith("builtin:") || path.startsWith("<"))) return undefined;
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

export type ToolPermission = "deny" | "allow" | "approval";
export type ToolPolicyInfo = Pick<ToolInfo, "name" | "exposure" | "annotations" | "sourceInfo">;
export interface ToolDecisions {
  sessionGrants: Iterable<string>;
  alwaysGrants: Iterable<string>;
  sessionDenials: Iterable<string>;
  alwaysDenials: Iterable<string>;
}
