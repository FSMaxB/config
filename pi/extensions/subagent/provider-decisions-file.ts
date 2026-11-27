import { readJsonObjectFile, writeJsonFileAtomically } from "../lib/json.ts";
import { emptyProviderDecisions, parseProviderDecisions } from "./cross-provider.ts";
import type { ProviderDecisions } from "./cross-provider.ts";

export async function updateProviderDecisions(
  file: string,
  update: (decisions: ProviderDecisions) => ProviderDecisions,
): Promise<void> {
  const next = update(await loadProviderDecisions(file));
  await writeJsonFileAtomically(file, next.toJson());
}

// Throws when the file exists but is damaged, so a damaged file is reported instead of being overwritten.
export async function loadProviderDecisions(file: string): Promise<ProviderDecisions> {
  const value = await readJsonObjectFile(file);
  if (value === undefined) return emptyProviderDecisions();
  const parsed = parseProviderDecisions(value);
  if (!parsed.ok) throw new Error(`${file} ${parsed.error}; fix or delete it.`);
  return parsed.decisions;
}
