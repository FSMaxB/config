/**
 * The value stored under `key` on globalThis, created by `create` on first use. Every copy of a
 * module in the process shares it, even when pi loads the module more than once. Version the key
 * when the value's shape changes, so two shapes never share a key.
 */
export function processGlobal<T>(key: string | symbol, create: () => T): T {
  const existing: unknown = Reflect.get(globalThis, key);
  if (existing !== undefined) {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- only processGlobal writes `key`, always with the result of `create`
    return existing as T;
  }
  const created = create();
  Reflect.set(globalThis, key, created);
  return created;
}
