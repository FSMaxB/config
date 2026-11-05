---
name: vcs
description: Use before reading VCS status or history, before making changes in a repository, before committing, and before creating fixup commits.
---

# VCS

- Detect the VCS first, unless the system prompt already names it: `jj root` succeeds in jj repositories, including colocated jj/git ones; otherwise run `git rev-parse --show-toplevel`.
- Use jj when the repository uses jj, including colocated jj/git repositories. Otherwise, ask before using git. Read-only git commands (e.g. `git status`, `git log`, `git diff`) are always fine; asking is only needed for commands that change commits, branches, or the index.
- Before making changes, inspect the working-copy status. If it already contains changes, make sure they don't end up in your commits.
- Put each distinct logical change in a separate clean commit. Never include unrelated or pre-existing changes.
- Always commit before verification. If verification finds issues, make fixups instead.

## Reading status and history

- Use jj or git commands on the shell; there are no dedicated VCS tools.
- When the working copy is read-only (for example in Pi's plan and explore mode), pass `--ignore-working-copy` to every jj command. `@` then reflects the last snapshot and can miss the newest edits.
- Keep output bounded: limit logs (`-n 20`), look at `--stat` or `--summary` first, then narrow diffs to the paths you need.

| Question | jj | git |
| --- | --- | --- |
| Status | `jj status` | `git status --short` |
| History | `jj log -r '<revset>' -n 20` | `git log --oneline -n 20 <range>` |
| One revision | `jj show <rev>` | `git show <rev>` |
| Diff | `jj diff -r <rev>` or `jj diff --from <a> --to <b>` | `git diff <a>..<b>` |
| File at a revision | `jj file show -r <rev> <path>` | `git show <rev>:<path>` |
| Blame | `jj file annotate -r <rev> <path>` | `git blame <rev> -- <path>` |
| Branches | `jj bookmark list --all-remotes` | `git branch -a -vv` |

## jj

- Finalize each change with `jj commit -m "..."`. This commits the current working-copy revision and creates a fresh empty working-copy revision directly on top of it.
- Finish with `jj status` showing an empty working copy whose parent is your completed change.
- Never change the working-copy parent, move bookmarks, or rebase without asking.

## git

- Stage only files and changes belonging to the current task, then create a normal commit.
- Finish with no uncommitted changes from your task. Do not modify, stage, stash, discard, or commit pre-existing changes.
- Never switch branches, move branches, merge, or rebase without asking.

## Fixups

- Do not amend or rewrite existing commits.
- Create a separate fixup commit that I can squash later.
- format: "fixup {id}: {description}"
- For jj it is fine for fixup commits to be made in between existing commits (they don't necessarily have to be on top)
- Identify the target in the commit message using its native identifier:
  - jj: the target’s change ID.
  - git: the target’s commit hash.
- Do not make fixups targeting multiple commits, split them into multiple instead.

I will handle all rebasing and history rewriting manually.
