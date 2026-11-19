// FooterComponent renders the working directory, then the stats line with the model on its right,
// then the extension statuses.
const STATS_ROW = 1;
const STATUS_ROW = 2;
// FooterComponent's separator between the model id and the thinking level.
const THINKING_SEPARATOR = " • ";
// FooterComponent joins the extension statuses with one space.
const STATUS_SEPARATOR_WIDTH = 1;
// indexOf and lastIndexOf report a missing needle with this.
const NOT_FOUND = -1;

export function footerTargetAt(
  snapshot: FooterSnapshot,
  column: number,
  row: number,
  measure: TextMeasure,
): FooterTarget | undefined {
  const line = snapshot.lines.at(row);
  if (line === undefined) return undefined;
  if (row === STATS_ROW) return modelTargetAt(measure.strip(line), snapshot.model, column, measure);
  if (row === STATUS_ROW) return statusTargetAt(snapshot.statuses, column, measure);
  return undefined;
}

export function thinkingDisplay(level: string): string {
  return level === "off" ? "thinking off" : level;
}

function modelTargetAt(
  plain: string,
  model: ModelDisplay | undefined,
  column: number,
  measure: TextMeasure,
): FooterTarget | undefined {
  if (model === undefined) return undefined;
  const span = locateModel(plain, model);
  if (span === undefined) return undefined;

  const columnOf = (index: number): number => measure.width(plain.slice(0, index));
  if (isWithin(column, columnOf(span.start), columnOf(span.idEnd))) return { kind: "model" };
  if (span.thinkingEnd !== undefined && isWithin(column, columnOf(span.idEnd), columnOf(span.thinkingEnd))) {
    return { kind: "thinking" };
  }
  return undefined;
}

function locateModel(plain: string, model: ModelDisplay): ModelSpan | undefined {
  const withThinking = model.thinking === undefined ? undefined : `${model.id}${THINKING_SEPARATOR}${model.thinking}`;
  const thinkingIndex = withThinking === undefined ? NOT_FOUND : plain.lastIndexOf(withThinking);
  // The right side is cut from its end when the line is too narrow, which can remove the level.
  const idIndex = thinkingIndex === NOT_FOUND ? plain.lastIndexOf(model.id) : thinkingIndex;
  if (idIndex === NOT_FOUND) return undefined;

  const idEnd = idIndex + model.id.length;
  const prefix = `(${model.provider}) `;
  const hasPrefix = plain.slice(Math.max(0, idIndex - prefix.length), idIndex) === prefix;
  return {
    start: hasPrefix ? idIndex - prefix.length : idIndex,
    idEnd,
    thinkingEnd: thinkingIndex === NOT_FOUND || withThinking === undefined ? undefined : thinkingIndex + withThinking.length,
  };
}

function statusTargetAt(
  statuses: ReadonlyMap<string, string>,
  column: number,
  measure: TextMeasure,
): FooterTarget | undefined {
  let start = 0;
  for (const [key, text] of [...statuses].sort(([a], [b]) => a.localeCompare(b))) {
    const width = measure.width(sanitizeStatusText(text));
    if (isWithin(column, start, start + width)) return { kind: "status", key };
    start += width + STATUS_SEPARATOR_WIDTH;
  }
  return undefined;
}

// Mirrors sanitizeStatusText in pi's footer.js, so the columns match what it renders.
function sanitizeStatusText(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function isWithin(column: number, start: number, end: number): boolean {
  return start <= column && column < end;
}

export type FooterTarget = { kind: "model" } | { kind: "thinking" } | { kind: "status"; key: string };

export interface FooterSnapshot {
  // As FooterComponent rendered them, terminal sequences included.
  lines: readonly string[];
  statuses: ReadonlyMap<string, string>;
  model: ModelDisplay | undefined;
}

export interface ModelDisplay {
  provider: string;
  id: string;
  // The text FooterComponent shows after the id; undefined for models without reasoning.
  thinking: string | undefined;
}

export interface TextMeasure {
  width(text: string): number;
  strip(text: string): string;
}

// String indices into the plain stats line.
interface ModelSpan {
  start: number;
  idEnd: number;
  // Undefined when the model has no thinking level or the line cut it off.
  thinkingEnd: number | undefined;
}
