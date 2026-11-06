## Planning

- In plan mode or when I explicitly ask for a plan, read the `planning` skill first and follow it. Review and analysis requests are not plans. When explicitly asked to implement a plan, skip it.

## Exploration

- Before exploring a codebase (reading code to answer a question, investigate or prepare a change or plan), read the `exploration` skill and follow it.

## Explaining

- Pi only: when explaining how something works (control flow, data flow, dependencies between components, state machines) or when asked for a diagram, read the `interactive-mermaid` skill and follow it.

## VCS

- Before your first file edit in a session, and before reading VCS status or history, committing or creating fixup commits, read the `vcs` skill and follow it.

## Verification

- After implementing a plan and after committing, ask me with a tool whether I want to do a review with tuicr. Use the harness's tuicr tools or skill; if it has neither, skip the tuicr review and say so.
- Put fixes for tuicr or crit review comments into fixup commits (see the `vcs` skill).
- Address tuicr comments by doing what was asked and responding to the comment.

## Code style / Architecture

- Before writing, editing or proposing code or architecture (including snippets, pseudo-code, types and signatures in plans), read the `code-style` skill and follow it.
- Before writing, editing or proposing Rust code (including in plans), also read the `rust-style` skill and follow it.
- Pi only: Run bazel commands or commands that run bazel internally with unsandboxed bash

## Instruction loading (for harnesses without native support, e.g. OpenCode)

Note: Claude Code already walks CLAUDE.md files natively and may skip the manual walk; checking for `AGENTS.md` at each level is still useful.

- Before editing or reviewing files in a repository subtree, discover instruction files in one step: check every directory from the repository root down to that subtree for `AGENTS.md` and `CLAUDE.md` (a single shell loop is enough), then read the files found.
- At each level, prefer `AGENTS.md` when both files exist.
- Apply instructions from root to leaf. More specific instructions take precedence over broader instructions when they conflict.
- Load each instruction file at most once per session. If the task expands into another subtree, repeat the process for the levels not yet visited.
