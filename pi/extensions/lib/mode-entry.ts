import { AgentMode, MODE_IDENTITIES, RESTRICTED_MODES, type RestrictedMode } from "./agent-mode.ts";

export interface Denial {
  name: string;
  note?: string;
}

export interface ModeEntry {
  enabled: boolean;
  sessionGrants: string[];
  sessionDenials: Denial[];
}

interface SessionManagerView {
  getEntries(): readonly unknown[];
  getBranch?(): readonly unknown[];
}

type CustomEntry = { type?: unknown; customType?: unknown; data?: unknown };

// The newest entry of a mode's type on the current branch holds that mode's live state, so
// navigating the session tree selects that branch's mode and decisions. The restricted-mode
// engine reads it to restore session state, and the subagent extension reads it to cap child
// tools without importing the engine. Adapters without getBranch fall back to all entries.
export function latestModeEntry(sessionManager: SessionManagerView, entryType: string): ModeEntry | undefined {
  return parseModeEntry(latestEntry(branchEntries(sessionManager), entryType)?.entry.data);
}

export interface ActiveRestrictedMode {
  mode: AgentMode;
  entry: ModeEntry | undefined;
  // Whether the branch holds any restricted-mode entry, enabled or not.
  recorded: boolean;
}

// Every mode switch writes an entry for each restricted mode, so normally at most one is
// enabled. If several are (an interrupted switch), the one recorded last on the branch wins.
export function activeRestrictedMode(sessionManager: SessionManagerView): ActiveRestrictedMode {
  const branch = branchEntries(sessionManager);
  const recorded = RESTRICTED_MODES.some((mode) => latestEntry(branch, MODE_IDENTITIES[mode].entryType) !== undefined);
  let winner: { index: number; mode: RestrictedMode; entry: ModeEntry } | undefined;
  for (const mode of RESTRICTED_MODES) {
    const latest = latestEntry(branch, MODE_IDENTITIES[mode].entryType);
    const entry = parseModeEntry(latest?.entry.data);
    if (!latest || !entry?.enabled || (winner && winner.index > latest.index)) continue;
    winner = { index: latest.index, mode, entry };
  }
  return { mode: winner?.mode ?? AgentMode.Execution, entry: winner?.entry, recorded };
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

// Denials used to be bare tool names, and sessions recorded before the note existed still are.
export function denialList(value: unknown): Denial[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [{ name: item }];
    if (!item || typeof item !== "object") return [];

    const { name, note } = item as { name?: unknown; note?: unknown };
    if (typeof name !== "string") return [];
    return [typeof note === "string" ? { name, note } : { name }];
  });
}

function branchEntries(sessionManager: SessionManagerView): readonly CustomEntry[] {
  return (typeof sessionManager.getBranch === "function" ? sessionManager.getBranch() : sessionManager.getEntries()) as readonly CustomEntry[];
}

function latestEntry(entries: readonly CustomEntry[], entryType: string): { index: number; entry: CustomEntry } | undefined {
  const index = entries.findLastIndex((entry) => entry.type === "custom" && entry.customType === entryType);
  return index < 0 ? undefined : { index, entry: entries[index] };
}

function parseModeEntry(data: unknown): ModeEntry | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { enabled, sessionGrants, sessionDenials } = data as Record<string, unknown>;
  return {
    enabled: enabled === true,
    sessionGrants: stringList(sessionGrants),
    sessionDenials: denialList(sessionDenials),
  };
}
