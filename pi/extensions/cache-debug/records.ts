import type { PayloadFingerprint } from "./fingerprint.ts";

export const RECORD_VERSION = 1;

export const Outcome = {
  Completed: "completed", // matched an assistant message_end with usage
  Superseded: "superseded", // the next request started first: cache warm, retry, compaction request
  Shutdown: "shutdown",
} as const;
export type Outcome = (typeof Outcome)[keyof typeof Outcome];

export const MarkerEvent = {
  SessionStart: "session_start",
  Compaction: "compaction",
  ModelSelect: "model_select",
  LogCapped: "log_capped",
} as const;
export type MarkerEvent = (typeof MarkerEvent)[keyof typeof MarkerEvent];

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface RequestRecord {
  version: typeof RECORD_VERSION;
  kind: "request";
  sessionId: string;
  provider: string;
  model: string;
  api: string;
  startedAt: string;
  completedAt?: string;
  payload?: PayloadFingerprint; // absent when the provider never exposes its payload (pi-claude)
  status?: number;
  responseHeaders?: Record<string, string>;
  usage?: Usage;
  stopReason?: string;
  responseId?: string; // provider's id for this response, for support tickets
  outcome: Outcome;
}

export interface MarkerRecord {
  version: typeof RECORD_VERSION;
  kind: "marker";
  sessionId: string;
  at: string;
  event: MarkerEvent;
  detail?: string;
}

export type LogRecord = RequestRecord | MarkerRecord;

interface RequestStart {
  sessionId: string;
  provider: string;
  model: string;
  api: string;
  at: Date;
  payload?: PayloadFingerprint;
}

interface AssistantMessageEnd {
  sessionId: string;
  provider: string;
  model: string;
  api: string;
  usage: Usage;
  stopReason: string;
  responseId?: string;
  at: Date;
}

// Requests within one pi process are sequential, so one pending record is enough.
export class RequestTracker {
  private pending: RequestRecord | undefined;
  private readonly emit: (record: LogRecord) => void;

  constructor(emit: (record: LogRecord) => void) {
    this.emit = emit;
  }

  request(start: RequestStart): void {
    this.flush(Outcome.Superseded);
    const { at, ...identity } = start;
    this.pending = { version: RECORD_VERSION, kind: "request", ...identity, startedAt: at.toISOString(), outcome: Outcome.Superseded };
  }

  response(status: number, headers: Record<string, string>): void {
    if (!this.pending) return;
    this.pending = { ...this.pending, status, responseHeaders: filterHeaders(headers) };
  }

  // The message names the physical model; context.model at request time may be a virtual model.
  assistantMessage(end: AssistantMessageEnd): void {
    const { at, usage, stopReason, responseId, ...identity } = end;
    const completedAt = at.toISOString();
    const base: RequestRecord = this.pending ?? { version: RECORD_VERSION, kind: "request", ...identity, startedAt: completedAt, outcome: Outcome.Completed };
    this.pending = undefined;
    this.emit({ ...base, ...identity, completedAt, usage: pickUsage(usage), stopReason, ...(responseId ? { responseId } : {}), outcome: Outcome.Completed });
  }

  shutdown(): void {
    this.flush(Outcome.Shutdown);
  }

  private flush(outcome: Outcome): void {
    if (!this.pending) return;
    this.emit({ ...this.pending, outcome });
    this.pending = undefined;
  }
}

// Response headers carry request ids, rate limits and cache hints; only credentials and cookies stay out.
const SECRET_HEADER = /cookie|authorization|api-key|secret/i;

export function filterHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !SECRET_HEADER.test(name)));
}

function pickUsage({ input, output, cacheRead, cacheWrite }: Usage): Usage {
  return { input, output, cacheRead, cacheWrite };
}
