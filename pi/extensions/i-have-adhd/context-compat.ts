export type ContextMessageMarker = Readonly<{
  type?: string;
  role?: string;
  customType?: string;
}>;

interface CompatibleSessionManager {
  buildSessionContext?: () => { messages: readonly ContextMessageMarker[] };
  buildContextEntries?: () => readonly ContextMessageMarker[];
}

export function contextMessages(
  compatible: CompatibleSessionManager,
): readonly ContextMessageMarker[] {
  // Context inspection is advisory. If a runtime changes its session-manager
  // API or temporarily cannot build context, report "not present" so the
  // caller can safely re-inject the rules instead of breaking session startup.
  try {
    if (typeof compatible.buildSessionContext === "function") {
      const messages = compatible.buildSessionContext().messages;
      return Array.isArray(messages) ? messages : [];
    }

    if (typeof compatible.buildContextEntries === "function") {
      const entries = compatible.buildContextEntries();
      return Array.isArray(entries) ? entries : [];
    }
  } catch {
    return [];
  }

  return [];
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
