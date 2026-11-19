import { isRecord } from "./untyped.ts";

const ATTENDED_CHANNEL = "config:prompt:attended";

// Prompts opened while the user is already at the terminal, such as a picker they opened by
// clicking the footer, need no "waiting for your input" notification. The opener and the notifier
// are separate extensions that load in any order, so they meet on the runtime's event bus.
export async function whileAttended<T>(events: AttendedEventBus, act: () => Promise<T>): Promise<T> {
  events.emit(ATTENDED_CHANNEL, { phase: "start" } satisfies AttendedSignal);
  try {
    return await act();
  } finally {
    events.emit(ATTENDED_CHANNEL, { phase: "end" } satisfies AttendedSignal);
  }
}

export function watchAttended(events: AttendedEventBus): AttendedWatch {
  // A depth, not a flag, so overlapping attended runs do not end each other's window.
  let depth = 0;
  events.on(ATTENDED_CHANNEL, (data) => {
    if (!isAttendedSignal(data)) return;
    // A stale "end" from a run that started before this watch must not push the depth below zero.
    depth = data.phase === "start" ? depth + 1 : Math.max(0, depth - 1);
  });
  return { isAttended: () => depth > 0 };
}

function isAttendedSignal(data: unknown): data is AttendedSignal {
  return isRecord(data) && (data.phase === "start" || data.phase === "end");
}

interface AttendedSignal {
  phase: "start" | "end";
}

export interface AttendedWatch {
  isAttended(): boolean;
}

/** The part of `pi.events` this module uses; a plain interface keeps it free of pi imports. */
export interface AttendedEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}
