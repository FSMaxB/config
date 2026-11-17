# TypeScript

## Functions and modules

- Declare module-level functions with `function`. Use arrow functions only for callbacks.
- Give every module-level function an explicit return type.
- Use named exports. Use a default export only where a framework requires one.
- Import types with `import type` and Node built-ins with the `node:` prefix.
- Pass ambient dependencies (environment, clock, file system) as parameters with a default: `environment: NodeJS.ProcessEnv = process.env`.

## Types

- Use only syntax that type stripping can erase: no `enum`, no `namespace`, no constructor parameter properties.
- Declare a closed set of values as a union of string literals. Use an `as const` object with a type of the same name only when the values are iterated or used as keys at runtime.

  ```ts
  export type PauseState = "running" | "pausing" | "paused";

  export const AgentMode = {
    Execution: "execution",
    Planning: "planning",
  } as const;
  export type AgentMode = (typeof AgentMode)[keyof typeof AgentMode];
  ```

- Declare a list of literals once and derive the union from it: `(typeof THINKING_LEVELS)[number]`.
- Use `interface` for object shapes and `type` for everything else (unions, tuples, function types, mapped types).
- Model variants as a discriminated union with a `kind` field instead of one object with optional fields.

  ```ts
  // Bad
  interface Option {
    answer?: Answer;
    narrower?: Scope[];
    needsReason?: boolean;
  }

  // Good
  type Option =
    | { kind: "answer"; answer: Answer }
    | { kind: "narrower"; scopes: readonly Scope[] }
    | { kind: "reason" };
  ```

- Do not use `any` or the non-null `!`. Do not change a type with `as`; `as const` is fine, and "Untyped data" below names the one other case.
- Check a literal against a type with `satisfies` when its narrow type should be kept; annotate otherwise.
- Use `undefined` for an absent value. Use `null` only where an external API or JSON produces it.
- Write `property: T | undefined` when every caller has to decide, and `property?: T` only for an option that has a default.
- Type parameters that are not mutated as `readonly T[]`, `ReadonlySet<T>` or `ReadonlyMap<K, V>`.
- Use `Map` and `Set` for dynamic keys, and `Record` only for a fixed set of keys.
- Make class members private with `#name`, not with the `private` keyword.

## Control flow

- Iterate with `for...of`, not `.forEach`. Use `.map` and `.filter` for transformations, and `.reduce` only for sums.
- In a `switch` over a union, return from every case and omit `default`, so the return type reports a missing case. When the cases do not return, end with `default: value satisfies never;`.
  ```ts
  function label(state: PauseState): string {
    switch (state) {
      case "running":
        return "Running";
      case "pausing":
        return "Pausing after this turn";
      case "paused":
        return "Paused";
    }
  }
  ```

## Errors

- In the functional core, return a failure the caller is expected to handle as a result union. Throw for bugs, and in the imperative shell.
  ```ts
  type ModelChoice = { ok: true; model: Model } | { ok: false; error: string };
  ```
- Throw only `Error` objects.
- Catch with `catch (error)` and narrow with `instanceof Error` before reading it. Write `catch {` when the error is not used.

## Untyped data

- Give the result of `JSON.parse`, command output and file contents the type `unknown`, and turn it into a typed value with a parse function that checks it.

  ```ts
  // Bad
  const settings = JSON.parse(raw) as Settings;

  // Good
  const parsed: unknown = JSON.parse(raw);
  const settings = parseSettings(parsed);
  ```

- `as` on parsed data is allowed only for data this process wrote itself.
