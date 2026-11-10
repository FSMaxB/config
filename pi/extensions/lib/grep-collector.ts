// Turns ripgrep --json events into the rows the grep tool prints, with the limit handling of pi's
// own grep tool (1.5.1). Pure, so it is unit-tested without rg.

export const LineOutcome = { Continue: "continue", Stop: "stop" } as const;
export type LineOutcome = (typeof LineOutcome)[keyof typeof LineOutcome];

export const GrepRowKind = { Match: "match", Context: "context" } as const;
export type GrepRowKind = (typeof GrepRowKind)[keyof typeof GrepRowKind];

export interface GrepRow {
  filePath: string;
  lineNumber: number;
  text: string;
  kind: GrepRowKind;
}

interface RipgrepText {
  text?: string;
  bytes?: string;
}

export interface RipgrepEvent {
  type?: string;
  data?: { path?: RipgrepText; line_number?: number; lines?: RipgrepText };
}

interface TrailingWindow {
  filePath: string;
  end: number;
}

export class GrepCollector {
  readonly rows: GrepRow[] = [];
  matchCount = 0;
  limitReached = false;
  private readonly limit: number;
  private readonly context: number;
  private trailingWindow: TrailingWindow | undefined;

  constructor(limit: number, context: number) {
    this.limit = limit;
    this.context = context;
  }

  accept(event: RipgrepEvent): LineOutcome {
    const row = rowOf(event);
    if (!row) return LineOutcome.Continue;
    if (!this.trailingWindow) return this.acceptWithinLimit(row);
    return this.acceptPastLimit(row, this.trailingWindow);
  }

  private acceptWithinLimit(row: GrepRow): LineOutcome {
    this.rows.push(row);
    if (row.kind === GrepRowKind.Context) return LineOutcome.Continue;
    this.matchCount++;
    if (this.matchCount >= this.limit) {
      this.trailingWindow = { filePath: row.filePath, end: row.lineNumber + this.context };
    }
    return LineOutcome.Continue;
  }

  // rg still sends the trailing context of the last allowed match. A match inside that window is
  // shown as context, and only another match proves that the limit cut results off.
  private acceptPastLimit(row: GrepRow, window: TrailingWindow): LineOutcome {
    const inWindow = row.filePath === window.filePath && row.lineNumber <= window.end;
    if (inWindow) this.rows.push({ ...row, kind: GrepRowKind.Context });
    if (row.kind === GrepRowKind.Match) this.limitReached = true;
    const windowComplete = !inWindow || row.lineNumber >= window.end;
    return this.limitReached && windowComplete ? LineOutcome.Stop : LineOutcome.Continue;
  }
}

export function parseRipgrepEvent(line: string): RipgrepEvent | undefined {
  try {
    return JSON.parse(line) as RipgrepEvent;
  } catch {
    return undefined;
  }
}

function rowOf(event: RipgrepEvent): GrepRow | undefined {
  const kind = event.type === "match" ? GrepRowKind.Match : event.type === "context" ? GrepRowKind.Context : undefined;
  if (!kind) return undefined;
  const filePath = decodeRipgrepText(event.data?.path);
  const lineNumber = event.data?.line_number;
  if (!filePath || typeof lineNumber !== "number") return undefined;
  // Only the line terminator is stripped: a lone CR inside a line is content, as in the read tool.
  const text = decodeRipgrepText(event.data?.lines).replace(/\r?\n?$/, "");
  return { filePath, lineNumber, text, kind };
}

// rg reports text that is not valid UTF-8 as base64 bytes.
function decodeRipgrepText(value: RipgrepText | undefined): string {
  if (value?.text !== undefined) return value.text;
  if (value?.bytes !== undefined) return Buffer.from(value.bytes, "base64").toString("utf8");
  return "";
}
