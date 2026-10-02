import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readJsonObject } from "./json.ts";
import { denialList, stringList, type Denial } from "./plan-mode-entry.ts";

export { latestPlanModeEntry, PLAN_MODE_ENTRY_TYPE, type Denial, type PlanModeEntry } from "./plan-mode-entry.ts";

const DECISIONS_FILE = join(getAgentDir(), "plan-mode.json");

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
