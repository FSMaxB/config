import type { AccessMode } from "./path-permission-rules.ts";

// Session-tier grants and denials live in several extensions (path rules, plan/explore tool decisions,
// sandbox network hosts, unsandboxed bash). They meet on the runtime's event bus because the extensions
// load in any order and cannot reach each other's closures; a new runtime has a new bus.

export type GrantDecision = "allow" | "deny";

export type SessionGrant =
  | { kind: "path"; decision: GrantDecision; access: AccessMode; target: string }
  | { kind: "tool"; decision: GrantDecision; name: string }
  | { kind: "network"; decision: GrantDecision; host: string }
  | { kind: "unsandboxed"; decision: GrantDecision };

/** The part of `pi.events` this module uses; a plain interface keeps it free of pi imports. */
export interface GrantEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

const COLLECT_CHANNEL = "config:session-grants:collect";
const CHANGED_CHANNEL = "config:session-grants:changed";

interface CollectRequest {
  grants: SessionGrant[];
}

// pi's bus calls handlers synchronously up to their first await, so every provider has filled the
// request by the time emit returns.
export function provideSessionGrants(events: GrantEventBus, provide: () => readonly SessionGrant[]): void {
  events.on(COLLECT_CHANNEL, (data) => {
    (data as CollectRequest).grants.push(...provide());
  });
}

export function collectSessionGrants(events: GrantEventBus): SessionGrant[] {
  const request: CollectRequest = { grants: [] };
  events.emit(COLLECT_CHANNEL, request);
  return request.grants;
}

export function announceSessionGrantsChanged(events: GrantEventBus): void {
  events.emit(CHANGED_CHANNEL, undefined);
}

export function onSessionGrantsChanged(events: GrantEventBus, handler: () => void): void {
  events.on(CHANGED_CHANNEL, handler);
}
