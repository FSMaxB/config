import { isRecord } from "../lib/untyped.ts";

export function contextMessages(
  compatible: CompatibleSessionManager,
): readonly ContextMessageMarker[] {
  // Context inspection is advisory. If a runtime changes its session-manager
  // API or temporarily cannot build context, report "not present" so the
  // caller can safely re-inject the rules instead of breaking session startup.
  try {
    if (typeof compatible.buildSessionContext === "function") {
      return markersOf(compatible.buildSessionContext().messages);
    }

    if (typeof compatible.buildContextEntries === "function") {
      return markersOf(compatible.buildContextEntries());
    }
  } catch {
    return [];
  }

  return [];
}

interface CompatibleSessionManager {
  buildSessionContext?: () => { messages: readonly ContextMessageMarker[] };
  buildContextEntries?: () => readonly ContextMessageMarker[];
}

export function latestMarkerIsActive(
  messages: readonly ContextMessageMarker[],
  activeType: string,
  disabledType: string,
): boolean {
  let active = false;

  for (const message of messages) {
    if (message.role !== "custom" && message.type !== "custom_message") {
      continue;
    }

    if (message.customType === activeType) {
      active = true;
    } else if (message.customType === disabledType) {
      active = false;
    }
  }

  return active;
}

function markersOf(value: unknown): readonly ContextMessageMarker[] {
  return Array.isArray(value) ? value.filter(isContextMessageMarker) : [];
}

function isContextMessageMarker(value: unknown): value is ContextMessageMarker {
  if (!isRecord(value)) return false;
  return [value.type, value.role, value.customType].every((field) => field === undefined || typeof field === "string");
}

export type ContextMessageMarker = Readonly<{
  type?: string;
  role?: string;
  customType?: string;
}>;
