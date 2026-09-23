// Extensions persist state by appending custom session entries, so the newest entry of a type
// holds the live state.
export function latestCustomData(
  sessionManager: { getEntries(): readonly unknown[] },
  customType: string,
): Record<string, unknown> | undefined {
  const entries = sessionManager.getEntries() as readonly { type?: unknown; customType?: unknown; data?: unknown }[];
  const data = entries.filter((entry) => entry.type === "custom" && entry.customType === customType).at(-1)?.data;
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : undefined;
}
