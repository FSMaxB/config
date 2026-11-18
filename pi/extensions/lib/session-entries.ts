import { isRecord } from "./untyped.ts";

// Extensions persist state by appending custom session entries, so the newest entry of a type
// holds the live state.
export function latestCustomData(
  sessionManager: { getEntries(): readonly unknown[] },
  customType: string,
): Record<string, unknown> | undefined {
  const data = latestCustomEntry(sessionManager.getEntries(), customType)?.data;
  return isRecord(data) ? data : undefined;
}

// The index lets callers compare how recent entries of different types are.
export function latestCustomEntry(entries: readonly unknown[], customType: string): { index: number; data: unknown } | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (isRecord(entry) && entry.type === "custom" && entry.customType === customType) return { index, data: entry.data };
  }
  return undefined;
}
