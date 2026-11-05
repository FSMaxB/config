---
name: vcs
description: Use before reading VCS status or history, before making changes in a repository, before committing, and before creating fixup commits.
---

# VCS

- Use jj when the repository uses jj, including colocated jj/git repositories. Otherwise, ask before using git. Read-only git commands (e.g. `git status`, `git log`, `git diff`) are always fine; asking is only needed for commands that change commits, branches, or the index.
- Before making changes, inspect the working-copy status. If it already contains changes, make sure they don't end up in your commits.
- Put each distinct logical change in a separate clean commit. Never include unrelated or pre-existing changes.
- Always commit before veritifcation. If veritifcation finds issues, make fixups instead.

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
