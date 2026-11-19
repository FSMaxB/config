import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord } from "./untyped.ts";

const STATUS_CLICK_CHANNEL = "config:footer:status-click";

// A click on an extension status in pi's footer is announced with the status key; the extension
// that owns the status reacts, e.g. by opening a picker or toggling. They meet on the runtime's
// event bus because extensions load in any order and cannot reach each other's closures.
export function onFooterStatusClick(
  events: StatusClickEventBus,
  key: string,
  act: (context: ExtensionContext) => Promise<void>,
): void {
  events.on(STATUS_CLICK_CHANNEL, (data) => {
    if (!isStatusClickRequest(data) || data.key !== key) return;
    data.actions.push(act(data.context));
  });
}

// Resolves once every owner of the status has finished, so the caller can serialize the reactions.
export async function clickStatus(events: StatusClickEventBus, key: string, context: ExtensionContext): Promise<void> {
  const request: StatusClickRequest = { key, context, actions: [] };
  events.emit(STATUS_CLICK_CHANNEL, request);
  await Promise.all(request.actions);
}

function isStatusClickRequest(data: unknown): data is StatusClickRequest {
  return isRecord(data) && typeof data.key === "string" && isRecord(data.context) && Array.isArray(data.actions);
}

interface StatusClickRequest {
  key: string;
  context: ExtensionContext;
  actions: Promise<void>[];
}

/** The part of `pi.events` this module uses; a plain interface keeps it free of pi imports. */
export interface StatusClickEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}
