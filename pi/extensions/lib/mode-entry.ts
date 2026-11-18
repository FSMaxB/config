import { AgentMode, MODE_IDENTITIES, RESTRICTED_MODES } from "./agent-mode.ts";
import type { RestrictedMode } from "./agent-mode.ts";
import { latestCustomEntry } from "./session-entries.ts";
import { isRecord } from "./untyped.ts";

export interface Denial {
  name: string;
  note: string | undefined;
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

// The newest entry of a mode's type on the current branch holds that mode's live state, so
// navigating the session tree selects that branch's mode and decisions. The restricted-mode
// engine reads it to restore session state, and the subagent extension reads it to cap child
// tools without importing the engine. Adapters without getBranch fall back to all entries.
export function latestModeEntry(sessionManager: SessionManagerView, entryType: string): ModeEntry | undefined {
  return parseModeEntry(latestCustomEntry(branchEntries(sessionManager), entryType)?.data);
}

// `recorded` says whether the branch holds any restricted-mode entry, enabled or not.
export type ActiveRestrictedMode =
  | { mode: typeof AgentMode.Execution; recorded: boolean }
  | { mode: RestrictedMode; entry: ModeEntry; recorded: boolean };

// Every mode switch writes an entry for each restricted mode, so normally at most one is
// enabled. If several are (an interrupted switch), the one recorded last on the branch wins.
export function activeRestrictedMode(sessionManager: SessionManagerView): ActiveRestrictedMode {
  const branch = branchEntries(sessionManager);
  const recorded = RESTRICTED_MODES.some((mode) => latestCustomEntry(branch, MODE_IDENTITIES[mode].entryType) !== undefined);
  let winner: { index: number; mode: RestrictedMode; entry: ModeEntry } | undefined;
  for (const mode of RESTRICTED_MODES) {
    const latest = latestCustomEntry(branch, MODE_IDENTITIES[mode].entryType);
    const entry = parseModeEntry(latest?.data);
    if (!latest || !entry?.enabled || (winner && winner.index > latest.index)) continue;
    winner = { index: latest.index, mode, entry };
  }
  if (winner === undefined) return { mode: AgentMode.Execution, recorded };
  return { mode: winner.mode, entry: winner.entry, recorded };
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

// A denial is a bare tool name or a { name, note } object.
export function denialList(value: unknown): Denial[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): Denial[] => {
    if (typeof item === "string") return [{ name: item, note: undefined }];
    if (!isRecord(item)) return [];

    const { name, note } = item;
    if (typeof name !== "string") return [];
    return [{ name, note: typeof note === "string" ? note : undefined }];
  });
}

function branchEntries(sessionManager: SessionManagerView): readonly unknown[] {
  return typeof sessionManager.getBranch === "function" ? sessionManager.getBranch() : sessionManager.getEntries();
}

function parseModeEntry(data: unknown): ModeEntry | undefined {
  if (!isRecord(data)) return undefined;
  const { enabled, sessionGrants, sessionDenials } = data;
  return {
    enabled: enabled === true,
    sessionGrants: stringList(sessionGrants),
    sessionDenials: denialList(sessionDenials),
  };
}
