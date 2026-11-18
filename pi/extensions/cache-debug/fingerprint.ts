import { createHash } from "node:crypto";
import { isRecord } from "../lib/untyped.ts";

export const SectionKind = { Content: "content", Parameter: "parameter" } as const;

export function fingerprintPayload(payload: unknown): PayloadFingerprint | undefined {
  if (!isRecord(payload)) return undefined;
  const sections = Object.entries(payload).map(([key, value]) => fingerprintSection(key, value));
  return { totalChars: sections.reduce((sum, { chars }) => sum + chars, 0), sections };
}

export interface PayloadFingerprint {
  totalChars: number;
  sections: Section[];
}

function fingerprintSection(key: string, value: unknown): Section {
  // Numbers and booleans are generation parameters (maxTokens, stream, temperature). Cache warming
  // sends maxTokens: 1, so treating them as content would flag every request after a warm.
  const kind = typeof value === "number" || typeof value === "boolean" ? SectionKind.Parameter : SectionKind.Content;
  const section = { key, kind, ...digest(value) };
  if (!Array.isArray(value)) return section;
  return { ...section, items: value.map((item) => ({ ...digest(item), ...labelOf(item) })) };
}

export interface Section {
  key: string;
  kind: SectionKind;
  hash: string;
  chars: number;
  items?: Item[];
}

export interface Item {
  hash: string;
  chars: number;
  label?: string;
}
export type SectionKind = (typeof SectionKind)[keyof typeof SectionKind];

// Prompt caches key on content, not on breakpoint markers, and Anthropic moves its marker to the
// newest message every turn. Key order is deliberately not normalized: providers serialize in
// insertion order, so a reordering is a real prefix change.
const CACHE_MARKER_KEYS = new Set(["cache_control", "cacheControl"]);

// Enough to tell payload sections apart, short enough to keep each log line small.
const HASH_LENGTH = 16;

function digest(value: unknown): { hash: string; chars: number } {
  const json = serializeWithoutCacheMarkers(value) ?? "null";
  return { hash: createHash("sha256").update(json).digest("hex").slice(0, HASH_LENGTH), chars: json.length };
}

// JSON.stringify returns undefined for a lone undefined, function or symbol, which its own type leaves out.
function serializeWithoutCacheMarkers(value: unknown): string | undefined {
  return JSON.stringify(value, (key: string, nested: unknown): unknown => (CACHE_MARKER_KEYS.has(key) ? undefined : nested));
}

function labelOf(item: unknown): { label?: string } {
  if (!isRecord(item)) return {};
  const nestedFunction = isRecord(item.function) ? item.function : {};
  const label = [item.role, item.name, nestedFunction.name, item.type].find((candidate): candidate is string => typeof candidate === "string");
  return label === undefined ? {} : { label };
}
