---
name: code-style
description: Use whenever you write, edit or propose code or architecture in any language, including code snippets, pseudo-code, types, signatures and design decisions in plans and reviews.
---

# Code style / Architecture

- Step-down rule: when adding a function or type, place it below its callers or users. Before finishing any edit that adds a helper, verify the helper appears after every site that calls it. If it doesn't, move it. Do not apply it to imports or module definitions!
- For tests, follow the arrange/act/assert style with an `arrange`, `act` and `assert` comment for each subsection. These labels are an intentional exception to the comment rule below.
- Do not under any circumstance add separating comments like `// ------------`
- Follow the "functional core, imperative shell" pattern when adequate
- Only add comments if they add context that is not part of the code itself. Explicitly do not duplicate what code is doing in the comments, only explain rationale and/or high level architecture.
- Do not use `err`, `ctx`, `recv` or similar abbreviations. Use full words like `error`, `context` or `receive`.
- Prefer explicit types (e.g. enum) instead of boolean when used as function arguments (booleans as method return types are fine if they is only used in an condition).
- Use early returns or equivalent where possible to prevent nesting the happy path.
