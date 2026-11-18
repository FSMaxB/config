// Narrowing helpers for values whose shape is not known statically, such as parsed JSON.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringProperty(value: object, key: string): string | undefined {
  const property: unknown = Reflect.get(value, key);
  return typeof property === "string" ? property : undefined;
}

/** `value`, or undefined when it is missing or empty, so `??` can supply one default for both. */
export function nonEmpty(value: string | undefined): string | undefined {
  return value === "" ? undefined : value;
}
