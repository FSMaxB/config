## Planning

- When in doubt (either during exploration or planning), prefer to ask me clarifying questions instead of extensive exploration
- When asking me questions, use the agent harness's question tool rather than plain text, when available (e.g. Claude Code: `AskUserQuestion`, Codex: `request_user_input`, OpenCode: `question`, etc.)
- Before starting implementation of any plan, load the crit skill and launch a crit review of the plan. Wait until I finish the review and address all unresolved comments before implementing.
  - In the Pi coding agent, run crit and fix all comments before `submit_plan`
- Explicitly include verification steps in the plan you write
- Write the plan with enough detail that a less capable model is still able to implement it.

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
- Identify the target in the commit message using its native identifier:
  - jj: the target’s change ID.
  - git: the target’s commit hash.

I will handle all rebasing and history rewriting manually.

## Verification

- After implementing a plan, ask me with a tool whether I want to do a review with tuicr. If yes, load the tuicr skill and use it for that.

## Code style / Architecture

### General

- Step-down rule: when adding a function or type, place it below its callers or users. Before finishing any edit that adds a helper, verify the helper appears after every site that calls it. If it doesn't, move it. Do not apply it to imports or module definitions!
- For tests, follow the `// arrange` `// act` `// assert` style with comments for the subsections
- Do not under any circumstance add separating comments like `// ------------`
- Follow the "functional core, imperative shell" pattern when adequate
- Only add comments if they add context that is not part of the code itself. Explicitly do not duplicate what code is doing in the comments, only explain rationale and/or high level architecture.
- Do not use `err`, `ctx`, `recv` or similar abbreviations. Use full words like `error`, `context` or `receive`.

### Rust

- Liberally use struct and enum destructuring, especially if it allows you to avoid an explicit type declaration of a let binding.
- Use pub instead of pub(crate) or pub(super) where applicable.
- If you want to make clear that something cannot happen, use `.unwrap_or(|| unreachable!(...))` instead of `.expect(...)`.
- If types can be inferred, let them be inferred.
- Prefer specifying types to the right of the `=`. E.g. `.collect<Vec<_>>()` instead of `let foo: Vec<_> = ....collect();`
- Put constants in the smallest scope possible (e.g. function scope if only used in that function)

## Instruction loading (for harnesses without native support, e.g. OpenCode)

Note: Claude Code already walks CLAUDE.md files natively and may skip the manual walk; checking for `AGENTS.md` at each level is still useful.

- Before editing or reviewing files in a repository subtree, discover instruction files in one step: check every directory from the repository root down to that subtree for `AGENTS.md` and `CLAUDE.md` (a single shell loop is enough), then read the files found.
- At each level, prefer `AGENTS.md` when both files exist.
- Apply instructions from root to leaf. More specific instructions take precedence over broader instructions when they conflict.
- Load each instruction file at most once per session. If the task expands into another subtree, repeat the process for the levels not yet visited.
