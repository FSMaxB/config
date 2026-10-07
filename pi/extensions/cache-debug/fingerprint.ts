import { createHash } from "node:crypto";

export const SectionKind = { Content: "content", Parameter: "parameter" } as const;
export type SectionKind = (typeof SectionKind)[keyof typeof SectionKind];

export interface PayloadFingerprint {
  totalChars: number;
  sections: Section[];
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

export function fingerprintPayload(payload: unknown): PayloadFingerprint | undefined {
  if (!isRecord(payload)) return undefined;
  const sections = Object.entries(payload).map(([key, value]) => fingerprintSection(key, value));
  return { totalChars: sections.reduce((sum, { chars }) => sum + chars, 0), sections };
}

function fingerprintSection(key: string, value: unknown): Section {
  // Numbers and booleans are generation parameters (maxTokens, stream, temperature). Cache warming
  // sends maxTokens: 1, so treating them as content would flag every request after a warm.
  const kind = typeof value === "number" || typeof value === "boolean" ? SectionKind.Parameter : SectionKind.Content;
  const section = { key, kind, ...digest(value) };
  if (!Array.isArray(value)) return section;
  return { ...section, items: value.map((item) => ({ ...digest(item), ...labelOf(item) })) };
}

// Prompt caches key on content, not on breakpoint markers, and Anthropic moves its marker to the
// newest message every turn. Key order is deliberately not normalized: providers serialize in
// insertion order, so a reordering is a real prefix change.
const CACHE_MARKER_KEYS = new Set(["cache_control", "cacheControl"]);

function digest(value: unknown): { hash: string; chars: number } {
  const json = JSON.stringify(value, (key, nested) => (CACHE_MARKER_KEYS.has(key) ? undefined : nested)) ?? "null";
  return { hash: createHash("sha256").update(json).digest("hex").slice(0, 16), chars: json.length };
}

function labelOf(item: unknown): { label?: string } {
  if (!isRecord(item)) return {};
  const nestedFunction = isRecord(item.function) ? item.function : {};
  const label = [item.role, item.name, nestedFunction.name, item.type].find((candidate) => typeof candidate === "string");
  return label === undefined ? {} : { label: label as string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
