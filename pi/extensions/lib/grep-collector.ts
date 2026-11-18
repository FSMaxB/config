// Turns ripgrep --json events into the rows the grep tool prints, with the limit handling of pi's
// own grep tool (1.5.1). Pure, so it is unit-tested without rg.

import { isRecord } from "./untyped.ts";

export const LineOutcome = { Continue: "continue", Stop: "stop" } as const;

export const GrepRowKind = { Match: "match", Context: "context" } as const;

export class GrepCollector {
  readonly rows: GrepRow[] = [];
  matchCount = 0;
  limitReached = false;
  readonly #limit: number;
  readonly #context: number;
  #trailingWindow: TrailingWindow | undefined;

  constructor(limit: number, context: number) {
    this.#limit = limit;
    this.#context = context;
  }

  accept(event: RipgrepEvent): LineOutcome {
    const row = rowOf(event);
    if (!this.#trailingWindow) return this.#acceptWithinLimit(row);
    return this.#acceptPastLimit(row, this.#trailingWindow);
  }

  #acceptWithinLimit(row: GrepRow): LineOutcome {
    this.rows.push(row);
    if (row.kind === GrepRowKind.Context) return LineOutcome.Continue;
    this.matchCount++;
    if (this.matchCount >= this.#limit) {
      this.#trailingWindow = { filePath: row.filePath, end: row.lineNumber + this.#context };
    }
    return LineOutcome.Continue;
  }

  // rg still sends the trailing context of the last allowed match. A match inside that window is
  // shown as context, and only another match proves that the limit cut results off.
  #acceptPastLimit(row: GrepRow, window: TrailingWindow): LineOutcome {
    const inWindow = row.filePath === window.filePath && row.lineNumber <= window.end;
    if (inWindow) this.rows.push({ ...row, kind: GrepRowKind.Context });
    if (row.kind === GrepRowKind.Match) this.limitReached = true;
    const windowComplete = !inWindow || row.lineNumber >= window.end;
    return this.limitReached && windowComplete ? LineOutcome.Stop : LineOutcome.Continue;
  }
}
export type LineOutcome = (typeof LineOutcome)[keyof typeof LineOutcome];

interface TrailingWindow {
  filePath: string;
  end: number;
}

export function parseRipgrepEvent(line: string): RipgrepEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed.data)) return undefined;
  const { type, data } = parsed;
  if (type !== "match" && type !== "context") return undefined;
  const path = parseRipgrepText(data.path);
  const lines = parseRipgrepText(data.lines);
  const lineNumber = data.line_number;
  if (path === undefined || lines === undefined || typeof lineNumber !== "number") return undefined;
  return { type, path, lineNumber, lines };
}

function parseRipgrepText(value: unknown): RipgrepText | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.text === "string") return { kind: "text", text: value.text };
  if (typeof value.bytes === "string") return { kind: "bytes", bytes: value.bytes };
  return undefined;
}

function rowOf(event: RipgrepEvent): GrepRow {
  const kind = event.type === "match" ? GrepRowKind.Match : GrepRowKind.Context;
  // Only the line terminator is stripped: a lone CR inside a line is content, as in the read tool.
  const text = decodeRipgrepText(event.lines).replace(/\r?\n?$/, "");
  return { filePath: decodeRipgrepText(event.path), lineNumber: event.lineNumber, text, kind };
}

export interface GrepRow {
  filePath: string;
  lineNumber: number;
  text: string;
  kind: GrepRowKind;
}
export type GrepRowKind = (typeof GrepRowKind)[keyof typeof GrepRowKind];

// Only the events that carry a line; rg's begin, end and summary events parse to undefined.
export interface RipgrepEvent {
  type: "match" | "context";
  path: RipgrepText;
  lineNumber: number;
  lines: RipgrepText;
}

function decodeRipgrepText(value: RipgrepText): string {
  switch (value.kind) {
    case "text":
      return value.text;
    case "bytes":
      return Buffer.from(value.bytes, "base64").toString("utf8");
  }
}

// rg reports text that is not valid UTF-8 as base64 bytes.
type RipgrepText = { kind: "text"; text: string } | { kind: "bytes"; bytes: string };
