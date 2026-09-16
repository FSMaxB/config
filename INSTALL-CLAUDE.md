## Planning

- If you are explicitly asked to implement a plan, ignore this entire planning section and start implementing.
- When in doubt (either during exploration or planning), prefer to ask me clarifying questions instead of extensive exploration
- When asking me questions, use the agent harness's question tool rather than plain text, when available (e.g. Claude Code: `AskUserQuestion`, Codex: `request_user_input`, OpenCode: `question`, etc.)
- Explicitly include verification steps in the plan you write
- Write a self-contained plan that a junior developer with no prior knowledge of this codebase could execute without asking questions or exploring on their own.
  - Do not defer decisions to the implementer, if multiple approaches exist, discuss them via the question tool first and then include the chosen approach.
  - When describing concrete code changes, prefer small code examples or pseudo-code over bullet points.
- When done with planning, launch a crit review of the plan. Wait until I finish the review and address all unresolved comments before submitting the plan for implementation.

## Exploration

- Delegate complex codebase exploration that requires reading lots of code to an explore subagent (when the harness provides one).
- Write the subagent brief so it contains everything already known, so the subagent verifies instead of re-deriving it.
- For mechanical fact-finding, run the subagent on a cheaper model or a lower thinking level than the main session instead of inheriting the session model. Pick the cheaper model from whatever provider the session uses.

## VCS

- Use jj when the repository uses jj, including colocated jj/git repositories. Otherwise, ask
  before using git.
- Before making changes, inspect the working-copy status. If it already contains changes, make sure they don't end up in your commits.
- Put each distinct logical change in a separate clean commit. Never include unrelated or pre-existing changes.

### jj

- Finalize each change with `jj commit -m "..."`. This commits the current working-copy revision and creates
  a fresh empty working-copy revision directly on top of it.
- Finish with `jj status` showing an empty working copy whose parent is your completed change.
- Never change the working-copy parent, move bookmarks, or rebase without asking.

### git

- Stage only files and changes belonging to the current task, then create a normal commit.
- Finish with no uncommitted changes from your task. Do not modify, stage, stash, discard, or commit
  pre-existing changes.
- Never switch branches, move branches, merge, or rebase without asking.

### Fixups

- Do not amend or rewrite existing commits.
- Create a separate fixup commit that I can squash later.
- format: "fixup {id}: {description}"
- For jj it is fine for fixup commits to be made in between existing commits (they don't necessarily have to be on top)
- Identify the target in the commit message using its native identifier:
  - jj: the target’s change ID.
  - git: the target’s commit hash.
- Do not make fixups targeting multiple commits, split them into multiple instead.

I will handle all rebasing and history rewriting manually.

## Verification

- After implementing a plan and after committing, ask me with a tool whether I want to do a review with tuicr.

## Code style / Architecture

### General

- Step-down rule: when adding a function or type, place it below its callers or users. Before finishing any edit that adds a helper, verify the helper appears after every site that calls it. If it doesn't, move it. Do not apply it to imports or module definitions!
- For tests, follow the `// arrange` `// act` `// assert` style with comments for the subsections
- Do not under any circumstance add separating comments like `// ------------`
- Follow the "functional core, imperative shell" pattern when adequate
- Only add comments if they add context that is not part of the code itself. Explicitly do not duplicate what code is doing in the comments, only explain rationale and/or high level architecture.
- Do not use `err`, `ctx`, `recv` or similar abbreviations. Use full words like `error`, `context` or `receive`.
- Prefer explicit types (e.g. enum) instead of boolean flags.
- Use early returns or equivalent where possible to prevent nesting the happy path.

### Rust

- Liberally use struct and enum destructuring, especially if it allows you to avoid an explicit type declaration of a let binding.
- Use pub instead of pub(crate) or pub(super) where applicable.
- If you want to make clear that something cannot happen, use `.unwrap_or(|| unreachable!(...))` instead of `.expect(...)`.
- If types can be inferred, let them be inferred.
- Prefer specifying types to the right of the `=`. E.g. `.collect<Vec<_>>()` instead of `let foo: Vec<_> = ....collect();`
- Put constants in the smallest scope possible (e.g. function scope if only used in that function)
- Prefer `let Some(...) = foo else { /* early exit / continue */ }` to nesting code in `if let Some` (same for other enums than Option).

## Instruction loading (for harnesses without native support, e.g. OpenCode)

Note: Claude Code already walks CLAUDE.md files natively and may skip the manual walk; checking for `AGENTS.md` at each level is still useful.

- Before editing or reviewing files in a repository subtree, discover instruction files in one step: check every directory from the repository root down to that subtree for `AGENTS.md` and `CLAUDE.md` (a single shell loop is enough), then read the files found.
- At each level, prefer `AGENTS.md` when both files exist.
- Apply instructions from root to leaf. More specific instructions take precedence over broader instructions when they conflict.
- Load each instruction file at most once per session. If the task expands into another subtree, repeat the process for the levels not yet visited.
