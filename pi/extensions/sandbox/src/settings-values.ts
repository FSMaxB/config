import { isRecord } from "../../lib/untyped.ts";

export function stringArray(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array of strings`);
  return value.map((entry: unknown) => {
    if (typeof entry !== "string") throw new Error(`${name} must be an array of strings`);
    return entry;
  });
}

export function stringRecord(value: unknown, name: string): Record<string, string> {
  if (value === undefined) return {};
  const strings: Record<string, string> = {};
  for (const [key, entry] of Object.entries(requireRecord(value, name))) {
    if (typeof entry !== "string") throw new Error(`${name} must be an object of strings`);
    strings[key] = entry;
  }
  return strings;
}

// Checking parsers for hand-edited sandbox.json values. `name` is the value's path in the file,
// so an error points at the entry to fix. An absent optional value parses to its empty default.

export function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${name} must be an object`);
  return value;
}

export function booleanValue(value: unknown, name: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

export function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
