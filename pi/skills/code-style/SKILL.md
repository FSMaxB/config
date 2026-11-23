---
name: code-style
description: Use whenever you write, edit or propose code or architecture in any language, including code snippets, pseudo-code, types, signatures and design decisions in plans and reviews.
---

# Code style / Architecture

- Step-down rule: when adding a function or type, place it below its callers or users. Before finishing any edit that adds a helper, verify the helper appears after every site that calls it. If it doesn't, move it. Do not apply it to imports or module definitions.
- Do not add separating comments like `// ------------`; split the code into functions or modules instead.
- Follow the "functional core, imperative shell" pattern when adequate
- In the functional core, prefer Faux-O (Gary Bernhardt, "Boundaries") over free functions: when a function's main input is a type defined in this codebase, make it a method on that type. Keep the type immutable: a method that changes something returns a new value instead of mutating the receiver. A function whose main input is a primitive or a type from another package stays a free function; do not group such functions in a static-only class or a namespace object.
- Only add comments if they add context that is not part of the code itself. Explicitly do not duplicate what code is doing in the comments, only explain rationale and/or high level architecture.
- Write comments about the code as it is. Do not describe the change ("now uses", "previously", "fixed", "new") and do not mention the task, plan or review that led to it.
- Doc comments contain information that is useful to the caller, for implementation details, comment on the relevant code directly.
- Do not use `err`, `ctx`, `recv` or similar abbreviations. Use full words like `error`, `context` or `receive`.
- Prefer explicit types (e.g. enum) instead of boolean when used as function arguments (a boolean return value is fine when it is only used in a condition).
- Use early returns or equivalent where possible to prevent nesting the happy path.
- Give a hardcoded value a named constant and a comment that says why it has that value (no magic numbers).

## Types and state

- Model mutually exclusive states as one sum type (enum, discriminated union), not as flags plus optional fields.
- Do not store a value that can be cheaply derived from other stored values. Derive it where it is needed, so the two cannot disagree.
- Use domain types instead of primitives: an id type instead of a string, a duration type instead of a number of milliseconds.
- Use the type system instead of relying on sentinel values (like `0` or `""` for "none")

## Misc

- Search the codebase and its dependencies for an existing helper before writing a new one.

## Tests

- Follow the arrange/act/assert style with an `arrange`, `act` and `assert` comment for each subsection. These labels are an intentional exception to the comment rule above.
- Bind the expected value to a name in the `arrange` section instead of writing it inline in the assertion.
- Test behaviour that could be wrong. Do not write a test that repeats a constant or mirrors the branches of the implementation.

## Language references

- Rust: read `references/rust.md`.
- TypeScript: read `references/typescript.md`.
