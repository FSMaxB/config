import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readJsonObject } from "./json.ts";

export const PLAN_MODE_ENTRY_TYPE = "plan-mode";

const DECISIONS_FILE = join(getAgentDir(), "plan-mode.json");

export interface Denial {
  name: string;
  note?: string;
}

export interface PlanModeEntry {
  enabled: boolean;
  sessionGrants: string[];
  sessionDenials: Denial[];
  planPath?: string;
}

// The newest "plan-mode" session entry holds the live plan-mode state. plan-mode.ts reads
// it to restore session state, and the subagent extension reads it to cap child tools
// without importing plan-mode.ts.
export function latestPlanModeEntry(
  sessionManager: { getEntries(): readonly unknown[] },
): PlanModeEntry | undefined {
  const entries = sessionManager.getEntries() as readonly {
    type: string;
    customType?: string;
    data?: unknown;
  }[];
  const entry = entries
    .filter(
      (candidate) =>
        candidate.type === "custom" &&
        candidate.customType === PLAN_MODE_ENTRY_TYPE,
    )
    .pop();
  if (!entry || typeof entry.data !== "object" || entry.data === null)
    return undefined;

  const { enabled, sessionGrants, sessionDenials, planPath } = entry.data as {
    enabled?: unknown;
    sessionGrants?: unknown;
    sessionDenials?: unknown;
    planPath?: unknown;
  };
  return {
    enabled: enabled === true,
    sessionGrants: stringList(sessionGrants),
    sessionDenials: denialList(sessionDenials),
    planPath: typeof planPath === "string" ? planPath : undefined,
  };
}

export async function readPersistedDecisions(): Promise<{
  alwaysAllowed: string[];
  alwaysDenied: Denial[];
}> {
  const parsed = await readJsonObject(DECISIONS_FILE);
  return {
    alwaysAllowed: stringList(parsed.alwaysAllowed),
    alwaysDenied: denialList(parsed.alwaysDenied),
  };
}

export async function writePersistedDecisions(
  allowed: Set<string>,
  denied: Map<string, string | undefined>,
): Promise<void> {
  await mkdir(dirname(DECISIONS_FILE), { recursive: true });
  const alwaysDenied = [...denied.keys()].sort().map((name) => {
    const note = denied.get(name);
    return note ? { name, note } : { name };
  });
  const content = { alwaysAllowed: [...allowed].sort(), alwaysDenied };
  await writeFile(DECISIONS_FILE, `${JSON.stringify(content, null, 2)}\n`);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

// Denials used to be bare tool names, and sessions recorded before the note existed still are.
function denialList(value: unknown): Denial[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [{ name: item }];
    if (!item || typeof item !== "object") return [];

    const { name, note } = item as { name?: unknown; note?: unknown };
    if (typeof name !== "string") return [];
    return [typeof note === "string" ? { name, note } : { name }];
  });
}
