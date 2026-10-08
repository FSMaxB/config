import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { MODE_IDENTITIES, type RestrictedMode } from "./agent-mode.ts";
import { readJsonObjectFile, writeJsonFileAtomically } from "./json.ts";
import { denialList, stringList, type Denial } from "./mode-entry.ts";

export async function readPersistedDecisions(mode: RestrictedMode): Promise<{
  alwaysAllowed: string[];
  alwaysDenied: Denial[];
}> {
  const parsed = (await readJsonObjectFile(decisionsFile(mode))) ?? {};
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
  // A file that no longer parses may hold decisions this session never loaded, so it must not be replaced.
  await readJsonObjectFile(file);
  const alwaysDenied = [...denied.keys()].sort().map((name) => {
    const note = denied.get(name);
    return note ? { name, note } : { name };
  });
  await writeJsonFileAtomically(file, { alwaysAllowed: [...allowed].sort(), alwaysDenied });
}

function decisionsFile(mode: RestrictedMode): string {
  return join(getAgentDir(), MODE_IDENTITIES[mode].decisionsFileName);
}
