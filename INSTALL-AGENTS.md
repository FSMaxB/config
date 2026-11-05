## Planning

- In plan mode or when I explicitly ask for a plan, read the `planning` skill first and follow it. Review and analysis requests are not plans. When explicitly asked to implement a plan, skip it.

## Exploration

- Before exploring a codebase (reading code to answer a question, investigate or prepare a change or plan), read the `exploration` skill and follow it.

## Explaining

- Pi only: when explaining how something works (control flow, data flow, dependencies between components, state machines) or when asked for a diagram, read the `interactive-mermaid` skill and follow it.

## VCS

- Before reading VCS status or history, making changes in a repository, committing or creating fixup commits, read the `vcs` skill and follow it.

## Verification

- After implementing a plan and after committing, ask me with a tool whether I want to do a review with tuicr. Use the harness's tuicr tools or skill; if it has neither, skip the tuicr review and say so.
- Put fixes for tuicr or crit review comments into fixup commits (see the `vcs` skill).
- Address tuicr comments by doing what was asked and responding to the comment.

## Code style / Architecture

### General

- Step-down rule: when adding a function or type, place it below its callers or users. Before finishing any edit that adds a helper, verify the helper appears after every site that calls it. If it doesn't, move it. Do not apply it to imports or module definitions!
- For tests, follow the arrange/act/assert style with an `arrange`, `act` and `assert` comment for each subsection. These labels are an intentional exception to the comment rule below.
- Do not under any circumstance add separating comments like `// ------------`
- Follow the "functional core, imperative shell" pattern when adequate
- Only add comments if they add context that is not part of the code itself. Explicitly do not duplicate what code is doing in the comments, only explain rationale and/or high level architecture.
- Do not use `err`, `ctx`, `recv` or similar abbreviations. Use full words like `error`, `context` or `receive`.
- Prefer explicit types (e.g. enum) instead of boolean when used as function arguments (booleans as method return types are fine if they is only used in an condition).
- Use early returns or equivalent where possible to prevent nesting the happy path.
- Pi only: Run bazel commands or commands that run bazel internally with unsandboxed bash

### Rust

- Before writing or editing Rust code, read the `rust-style` skill and follow it.

## Instruction loading (for harnesses without native support, e.g. OpenCode)

Note: Claude Code already walks CLAUDE.md files natively and may skip the manual walk; checking for `AGENTS.md` at each level is still useful.

- Before editing or reviewing files in a repository subtree, discover instruction files in one step: check every directory from the repository root down to that subtree for `AGENTS.md` and `CLAUDE.md` (a single shell loop is enough), then read the files found.
- At each level, prefer `AGENTS.md` when both files exist.
- Apply instructions from root to leaf. More specific instructions take precedence over broader instructions when they conflict.
- Load each instruction file at most once per session. If the task expands into another subtree, repeat the process for the levels not yet visited.
