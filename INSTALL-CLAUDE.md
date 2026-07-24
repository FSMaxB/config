## Planning

- When in doubt (either during exploration or planning), prefer to ask me clarifying questions instead of extensive exploration

## VCS

- Use the jj VCS, not git
- Where possible, make individual commits for individual changes
- Never switch onto a different jj commit without asking. I will do any rebasing manually once you're done.
- When fixing up commits, don't fix them directly but create separate fixup commits that I can squash later. In the commit message, refer to the target via the jj revision, not git commit.

## Verification

- Ask me whether I want to do a review with tuicr. If yes, load the tuicr skill and use it for that.

## Code style / Architecture

- Step-down rule: when adding a function or type, place it below its callers or users. Before finishing any edit that adds a helper, verify the helper appears after every site that calls it. If it doesn't, move it. Do not apply it to imports or module definitions!
- For tests, follow the `// arrange` `// act` `// assert` style with comments for the subsections
- Liberally use struct and enum destructuring, especially if it allows you to avoid an explicit type declaration of a let binding.
- Do not under any circumstance add separating comments like `// ------------`
- Follow the "functional core, imperative shell" pattern when adequate
- Only add comments if they add context that is not part of the code itself. Explicitly do not duplicate what code is doing in the comments, only explain rationale and or high level architecture.
- Use pub instead of pub(crate) or pub(super) where applicable.
- Do not use `err`, `ctx`, `recv` or similar abbreviations. Use full words like `error`,`context` or `receive`.

## Instruction loading (since OpenCode doesn't do this by default)

- Before editing or reviewing files in a repository subtree, walk from the repository root to that subtree and load the instruction file at each directory level.
- At each level, read `AGENTS.md` when present; otherwise, read `CLAUDE.md` when present.
- Apply instructions from root to leaf. More specific instructions take precedence over broader instructions when they conflict.
- If the task expands into another subtree, repeat this process before working there.
