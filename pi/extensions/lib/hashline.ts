// Line-anchored patch protocol adapted from oh-my-pi (can1357/oh-my-pi, MIT), reduced to a
// faithful subset: PUT replace, PUT insert before/after, CUT delete. No tree-sitter block ops,
// registers, or multi-file sections. See the plan in
// ~/.pi/agent/plans/Users-maxbruckner-config/20260909-1322-hashline-read-write-edit-for-pi-extensions.md
// for the full design rationale.
import { createHash } from "node:crypto";

export interface Snapshot {
  tag: string;
  lines: string[];
  trailingNewline: boolean;
  lineEnding: "\n" | "\r\n";
}

export type Op =
  | { kind: "replace"; from: number; to: number; body: string[] }
  | { kind: "delete"; from: number; to: number }
  | { kind: "insert"; at: number; side: "before" | "after"; body: string[] };

export interface Patch {
  path: string;
  tag: string;
  ops: Op[];
}

export interface Range {
  from: number;
  to: number;
}

export function tagOf(content: string): string {
  return createHash("sha256")
    .update(content)
    .digest("hex")
    .slice(0, 4)
    .toUpperCase();
}

export function snapshotOf(content: string): Snapshot {
  if (content === "") {
    return { tag: tagOf(content), lines: [], trailingNewline: false, lineEnding: "\n" };
  }
  const lineEnding: "\n" | "\r\n" = content.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = /\r?\n$/.test(content);
  const rawLines = content.split(/\r?\n/);
  const lines = trailingNewline ? rawLines.slice(0, -1) : rawLines;
  return { tag: tagOf(content), lines, trailingNewline, lineEnding };
}

const MAX_PATHS = 200;
const MAX_SNAPSHOTS_PER_PATH = 8;
const MAX_CACHEABLE_BYTES = 2 * 1024 * 1024;

// LRU by path (insertion order = recency), each holding up to MAX_SNAPSHOTS_PER_PATH snapshots
// in write order. One instance is shared by every extension: ESM caches modules by resolved
// path, so read/write/edit tools across files, repo-files.ts and memory.ts all share this cache.
const snapshotsByPath = new Map<string, Snapshot[]>();

export function recordSnapshot(absolutePath: string, content: string): Snapshot {
  const snapshot = snapshotOf(content);
  if (Buffer.byteLength(content, "utf8") > MAX_CACHEABLE_BYTES) return snapshot;

  const history = snapshotsByPath.get(absolutePath) ?? [];
  history.push(snapshot);
  if (history.length > MAX_SNAPSHOTS_PER_PATH) history.shift();

  snapshotsByPath.delete(absolutePath);
  snapshotsByPath.set(absolutePath, history);
  if (snapshotsByPath.size > MAX_PATHS) {
    const oldest = snapshotsByPath.keys().next().value;
    if (oldest !== undefined) snapshotsByPath.delete(oldest);
  }
  return snapshot;
}

export function findSnapshot(absolutePath: string, tag: string): Snapshot | undefined {
  const history = snapshotsByPath.get(absolutePath);
  if (history === undefined) return undefined;

  snapshotsByPath.delete(absolutePath);
  snapshotsByPath.set(absolutePath, history);
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].tag === tag) return history[index];
  }
  return undefined;
}

// Grammar, parsed line by line:
//   [path/to/file#A1B2]     header, first non-blank line
//   PUT 12.=14:             replace lines 12-14, body rows follow
//   +  const x = 1;
//   +
//   PUT <1:                 insert before line 1
//   PUT >$:                 insert after the last line
//   CUT 30.=32              delete lines 30-32, no body
// `$` stands for the last line of the snapshot the tag names, and is carried through as
// `Infinity` until a concrete snapshot resolves it (see resolveOp).
export function parsePatch(input: string): Patch {
  const rawLines = input.split(/\r?\n/);
  let index = 0;
  while (index < rawLines.length && rawLines[index].trim() === "") index += 1;

  const headerMatch =
    index < rawLines.length ? rawLines[index].match(/^\[(.+)#([0-9A-Fa-f]{4})\]$/) : null;
  if (!headerMatch) {
    throw new Error(
      "A hashline patch must start with [path#TAG], copied from your last read of the file.",
    );
  }
  const path = headerMatch[1];
  const tag = headerMatch[2].toUpperCase();
  index += 1;

  type OpenOp = Extract<Op, { kind: "replace" } | { kind: "insert" }>;
  const ops: Op[] = [];
  let current: OpenOp | undefined;

  const flush = () => {
    const op = current;
    if (op === undefined) return;
    if (op.body.length === 0) {
      throw new Error(
        `${opLabel(op)} has no body rows. An empty PUT is almost always a mistake; use CUT to delete instead.`,
      );
    }
    ops.push(op);
    current = undefined;
  };

  for (; index < rawLines.length; index += 1) {
    const line = rawLines[index];
    const patchLineNumber = index + 1;
    if (line.trim() === "") continue;

    const replaceMatch = line.match(/^PUT (\d+|\$)\.=(\d+|\$):$/);
    const insertBeforeMatch = line.match(/^PUT <(\d+|\$):$/);
    const insertAfterMatch = line.match(/^PUT >(\d+|\$):$/);
    const deleteMatch = line.match(/^CUT (\d+|\$)\.=(\d+|\$)$/);

    if (replaceMatch) {
      flush();
      const from = checkAnchor(replaceMatch[1], patchLineNumber);
      const to = checkAnchor(replaceMatch[2], patchLineNumber);
      checkOrder(from, to, patchLineNumber);
      current = { kind: "replace", from, to, body: [] };
      continue;
    }
    if (insertBeforeMatch) {
      flush();
      current = {
        kind: "insert",
        at: checkAnchor(insertBeforeMatch[1], patchLineNumber),
        side: "before",
        body: [],
      };
      continue;
    }
    if (insertAfterMatch) {
      flush();
      current = {
        kind: "insert",
        at: checkAnchor(insertAfterMatch[1], patchLineNumber),
        side: "after",
        body: [],
      };
      continue;
    }
    if (deleteMatch) {
      flush();
      const from = checkAnchor(deleteMatch[1], patchLineNumber);
      const to = checkAnchor(deleteMatch[2], patchLineNumber);
      checkOrder(from, to, patchLineNumber);
      ops.push({ kind: "delete", from, to });
      continue;
    }
    if (line.startsWith("+")) {
      if (current === undefined) {
        throw new Error(
          `Line ${patchLineNumber} of the patch is a '+' body row with no preceding PUT op (CUT takes no body).`,
        );
      }
      current.body.push(line.slice(1));
      continue;
    }
    if (line.startsWith("-")) {
      throw new Error(
        "hashline bodies list only the final content; the range decides what is removed. Drop the -lines.",
      );
    }
    throw new Error(
      `Line ${patchLineNumber} of the patch ("${line}") is not a recognized op (PUT/CUT) or a '+' body row.`,
    );
  }
  flush();

  if (ops.length === 0) {
    throw new Error("A hashline patch needs at least one PUT or CUT op.");
  }
  checkNoOverlap(ops);

  return { path, tag, ops };
}

function checkAnchor(raw: string, patchLineNumber: number): number {
  if (raw === "$") return Infinity;
  const value = Number.parseInt(raw, 10);
  if (value <= 0) {
    throw new Error(
      `Line ${patchLineNumber} of the patch names line ${value}, but line numbers start at 1.`,
    );
  }
  return value;
}

function checkOrder(from: number, to: number, patchLineNumber: number): void {
  if (Number.isFinite(from) && Number.isFinite(to) && from > to) {
    throw new Error(
      `Line ${patchLineNumber} of the patch has a range that starts after it ends (${from}.=${to}).`,
    );
  }
}

function opLabel(op: Op): string {
  switch (op.kind) {
    case "replace":
      return `PUT ${anchorLabel(op.from)}.=${anchorLabel(op.to)}:`;
    case "insert":
      return `PUT ${op.side === "before" ? "<" : ">"}${anchorLabel(op.at)}:`;
    case "delete":
      return `CUT ${anchorLabel(op.from)}.=${anchorLabel(op.to)}`;
  }
}

function anchorLabel(value: number): string {
  return Number.isFinite(value) ? String(value) : "$";
}

// Every op covers an interval on the shared original numbering: replace/delete are
// [from, to], an insert is the zero-width point just before or after its anchor line.
// Comparisons work with unresolved `$` (Infinity) because it is always the largest possible
// anchor for the snapshot every op in a patch shares.
function checkNoOverlap(ops: Op[]): void {
  const intervals = ops.map(opInterval);
  for (let i = 0; i < intervals.length; i += 1) {
    for (let j = i + 1; j < intervals.length; j += 1) {
      const [aFrom, aTo] = intervals[i];
      const [bFrom, bTo] = intervals[j];
      if (aFrom <= bTo && bFrom <= aTo) {
        throw new Error(
          "ops in one patch must not overlap; they all address the same snapshot",
        );
      }
    }
  }
}

function opInterval(op: Op): [number, number] {
  if (op.kind === "insert") {
    const point = op.at + (op.side === "after" ? 0.5 : -0.5);
    return [point, point];
  }
  return [op.from, op.to];
}

// Applies ops from the highest anchor down, so an earlier splice never shifts an anchor a
// later splice still needs. `changed` reports the edited regions in the *new* file's line
// numbers, computed by shifting each op's original-numbering result by the net delta of every
// op positioned before it.
export function applyOps(
  snapshot: Snapshot,
  ops: Op[],
): { content: string; changed: Range[] } {
  const resolved = ops.map((op) => resolveOp(op, snapshot.lines.length));

  const lines = [...snapshot.lines];
  const descending = [...resolved].sort((a, b) => anchorPosition(b) - anchorPosition(a));
  for (const op of descending) applyOneOp(lines, op);

  const body = lines.join(snapshot.lineEnding);
  const content = snapshot.trailingNewline ? body + snapshot.lineEnding : body;

  const changed = resolved.map((op) => {
    const original = originalRange(op);
    const shift = resolved
      .filter((other) => anchorPosition(other) < anchorPosition(op))
      .reduce((sum, other) => sum + delta(other), 0);
    return { from: original.from + shift, to: original.to + shift };
  });

  return { content, changed };
}

function resolveOp(op: Op, lineCount: number): Op {
  if (op.kind === "insert") {
    const at = op.at === Infinity ? Math.max(lineCount, 1) : op.at;
    if (lineCount === 0) {
      if (at !== 1) {
        throw new Error(
          `Insert anchor ${anchorLabel(op.at)} is out of bounds for an empty file; use PUT <1: to insert into it.`,
        );
      }
    } else if (at < 1 || at > lineCount) {
      throw new Error(
        `Insert anchor ${anchorLabel(op.at)} is out of bounds for a file with ${lineCount} lines.`,
      );
    }
    return { ...op, at };
  }

  const from = op.from === Infinity ? lineCount : op.from;
  const to = op.to === Infinity ? lineCount : op.to;
  if (from < 1 || to > lineCount) {
    throw new Error(
      `Range ${anchorLabel(op.from)}.=${anchorLabel(op.to)} is out of bounds for a file with ${lineCount} lines.`,
    );
  }
  if (from > to) {
    throw new Error(
      `Range ${anchorLabel(op.from)}.=${anchorLabel(op.to)} starts after it ends once resolved (${from}.=${to}).`,
    );
  }
  return { ...op, from, to };
}

function anchorPosition(op: Op): number {
  if (op.kind === "insert") return op.at + (op.side === "after" ? 0.5 : -0.5);
  return op.from;
}

function applyOneOp(lines: string[], op: Op): void {
  switch (op.kind) {
    case "replace":
      lines.splice(op.from - 1, op.to - op.from + 1, ...op.body);
      break;
    case "delete":
      lines.splice(op.from - 1, op.to - op.from + 1);
      break;
    case "insert": {
      const index = op.side === "before" ? op.at - 1 : op.at;
      lines.splice(index, 0, ...op.body);
      break;
    }
  }
}

// Range in original numbering, before any shift from earlier ops is applied. Deletions and
// empty PUT bodies (which parsePatch otherwise forbids, but delete legitimately has none)
// are reported as an empty range (from > to) marking the position they left behind.
function originalRange(op: Op): Range {
  if (op.kind === "insert") {
    const index = op.side === "before" ? op.at - 1 : op.at;
    return op.body.length === 0
      ? { from: index + 1, to: index }
      : { from: index + 1, to: index + op.body.length };
  }
  if (op.kind === "delete") return { from: op.from, to: op.from - 1 };
  return { from: op.from, to: op.from + op.body.length - 1 };
}

function delta(op: Op): number {
  const newLength = op.kind === "delete" ? 0 : op.body.length;
  const oldLength = op.kind === "insert" ? 0 : op.to - op.from + 1;
  return newLength - oldLength;
}

// Stale-tag recovery: each op's anchor is relocated by finding its exact original content
// uniquely in the current file. Fails closed — zero or multiple matches is an error, never a
// guess, because the model can always recover by reading the file again.
export function remapOps(ops: Op[], from: Snapshot, to: Snapshot): Op[] {
  return ops.map((op) => remapOp(op, from, to));
}

function remapOp(op: Op, from: Snapshot, to: Snapshot): Op {
  if (op.kind === "insert") {
    const at = op.at === Infinity ? from.lines.length : op.at;
    if (at === 1 && op.side === "before") return { ...op, at: 1 };
    if (at === from.lines.length && op.side === "after") {
      return { ...op, at: to.lines.length };
    }
    const newIndex = findUniqueOccurrence(to.lines, [from.lines[at - 1]]);
    return { ...op, at: newIndex + 1 };
  }

  const resolvedFrom = op.from === Infinity ? from.lines.length : op.from;
  const resolvedTo = op.to === Infinity ? from.lines.length : op.to;
  const block = from.lines.slice(resolvedFrom - 1, resolvedTo);
  const newStart = findUniqueOccurrence(to.lines, block);
  const shift = newStart - (resolvedFrom - 1);
  return { ...op, from: resolvedFrom + shift, to: resolvedTo + shift };
}

function findUniqueOccurrence(haystack: string[], needle: string[]): number {
  const matches: number[] = [];
  for (let index = 0; index + needle.length <= haystack.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) matches.push(index);
  }
  if (matches.length !== 1) {
    throw new Error(
      "This hashline anchor is stale and the lines it names have changed or moved ambiguously. Read the file again and re-anchor.",
    );
  }
  return matches[0];
}

export function renderNumbered(lines: string[], firstLineNumber: number): string {
  return lines.map((line, index) => `${firstLineNumber + index}:${line}`).join("\n");
}

export function renderRegions(snapshot: Snapshot, ranges: Range[], context = 3): string {
  const merged = mergeRanges(ranges, context, snapshot.lines.length);
  return merged
    .map(({ from, to }) => renderNumbered(snapshot.lines.slice(from - 1, to), from))
    .join("\n\n");
}

function mergeRanges(ranges: Range[], context: number, lineCount: number): Range[] {
  const expanded = ranges
    .map((range) => ({
      from: Math.max(1, Math.min(range.from, range.to + 1) - context),
      to: Math.min(lineCount, Math.max(range.to, range.from - 1) + context),
    }))
    .sort((a, b) => a.from - b.from);

  const merged: Range[] = [];
  for (const range of expanded) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.from <= last.to + 1) {
      last.to = Math.max(last.to, range.to);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}
