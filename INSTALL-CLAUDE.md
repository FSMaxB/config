## Planning

- When in doubt (either during exploration or planning), prefer to ask me clarifying questions instead of extensive exploration
- When asking me questions, use the agent harness's question tool rather than plain text, when available (e.g. Claude Code: `AskUserQuestion`, Codex: `request_user_input`, OpenCode: `question`, etc.)
- Before starting implementation of any plan, load the crit skill and launch a crit review of the plan. Wait until I finish the review and address all unresolved comments before implementing.
  - In the Pi coding agent, run crit and fix all comments before `submit_plan`

## VCS

- Use jj, not git, in repos where jj is set up; otherwise ask before using git.
- When you make a distinct change, put it in a separate clean commit (without accidentally folding existing changes into it)
- Never switch onto a different branch without asking. I will do any rebasing manually once you're done.
- When fixing up commits, don't fix them directly but create separate fixup commits that I can squash later. In the commit message, refer to the target via the VCS native revision ID (e.g. jj revision instead of commit hash for jj repos)

## Verification

- After implementing a plan, ask me whether I want to do a review with tuicr. If yes, load the tuicr skill and use it for that.

## Code style / Architecture

- Step-down rule: when adding a function or type, place it below its callers or users. Before finishing any edit that adds a helper, verify the helper appears after every site that calls it. If it doesn't, move it. Do not apply it to imports or module definitions!
- For tests, follow the `// arrange` `// act` `// assert` style with comments for the subsections
- Liberally use struct and enum destructuring, especially if it allows you to avoid an explicit type declaration of a let binding.
- Do not under any circumstance add separating comments like `// ------------`
- Follow the "functional core, imperative shell" pattern when adequate
- Only add comments if they add context that is not part of the code itself. Explicitly do not duplicate what code is doing in the comments, only explain rationale and/or high level architecture.
- Use pub instead of pub(crate) or pub(super) where applicable.
- Do not use `err`, `ctx`, `recv` or similar abbreviations. Use full words like `error`, `context` or `receive`.

## Instruction loading (for harnesses without native support, e.g. OpenCode)

Note: Claude Code already walks CLAUDE.md files natively and may skip the manual walk; checking for `AGENTS.md` at each level is still useful.

- Before editing or reviewing files in a repository subtree, discover instruction files in one step: check every directory from the repository root down to that subtree for `AGENTS.md` and `CLAUDE.md` (a single shell loop is enough), then read the files found.
- At each level, prefer `AGENTS.md` when both files exist.
- Apply instructions from root to leaf. More specific instructions take precedence over broader instructions when they conflict.
- Load each instruction file at most once per session. If the task expands into another subtree, repeat the process for the levels not yet visited.
