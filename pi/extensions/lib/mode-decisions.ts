import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { MODE_IDENTITIES, type RestrictedMode } from "./agent-mode.ts";
import { readJsonObject } from "./json.ts";
import { denialList, stringList, type Denial } from "./mode-entry.ts";

export async function readPersistedDecisions(mode: RestrictedMode): Promise<{
  alwaysAllowed: string[];
  alwaysDenied: Denial[];
}> {
  const parsed = await readJsonObject(decisionsFile(mode));
  return {
    alwaysAllowed: stringList(parsed.alwaysAllowed),
    alwaysDenied: denialList(parsed.alwaysDenied),
  };
}

export async function writePersistedDecisions(
  mode: RestrictedMode,
  allowed: Set<string>,
  denied: Map<string, string | undefined>,
): Promise<void> {
  const file = decisionsFile(mode);
  await mkdir(dirname(file), { recursive: true });
  const alwaysDenied = [...denied.keys()].sort().map((name) => {
    const note = denied.get(name);
    return note ? { name, note } : { name };
  });
  const content = { alwaysAllowed: [...allowed].sort(), alwaysDenied };
  await writeFile(file, `${JSON.stringify(content, null, 2)}\n`);
}

function decisionsFile(mode: RestrictedMode): string {
  return join(getAgentDir(), MODE_IDENTITIES[mode].decisionsFileName);
}
