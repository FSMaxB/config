---
name: jj-megamerge
description: Use in a jj repository that has a `merge` bookmark, before reading its history, committing, syncing with main, rebasing, refreshing git-lfs files, creating or moving bookmarks, or pushing.
---

# jj megamerge

Max keeps every open PR, every branch that will become a PR and every local-only change as a parallel **lane** between `main` and an empty octopus merge commit with the bookmark `merge`. Work that is unfinished or not assigned to a lane yet sits on top of `merge`.

The workflow applies when `jj log -r 'present(merge)'` shows a commit. When the working copy is read-only, pass `--ignore-working-copy` to every jj command.

## Layout

```text
@  (empty)
○  Unfinished work
○        merge (empty)
├─┬─┬─╮
│ │ │ ○  feature-c Feature C
│ │ ○ │  feature-b Feature B, stacked on A
│ │ ○ │  feature-a Feature A
│ │ ├─╯
│ ○ │  Not PR-bound yet
│ ├─╯
○ │  DO NOT MERGE: notes
○ │  LFS
○ │  DO NOT PUSH: local only
├─╯
◆  main
```

- **Lane**: a linear chain from a child of `main` to a parent of `merge`. Lanes are independent of each other.
- **Lane head**: a parent of `merge`. Its bookmark is the branch of a PR.
- **Stacked bookmarks**: a lane can carry several bookmarks. Each one is its own branch; the lower one lands first.
- **Lane without a bookmark**: not PR-bound yet. Treat it like a local-only lane until Max names it.
- **Local-only lane**: its root is an empty commit `DO NOT PUSH: local only` directly on `main`, without a bookmark. Nothing in it is ever pushed.
- **`DO NOT MERGE` commits**: local material (notes, analysis, agent docs). They must never end up in a PR: never push them and never move them into a bookmarked lane.
- **LFS commit** (repositories that use git-lfs, i.e. `.gitattributes` contains `filter=lfs`): jj doesn't run git-lfs filters, so a single commit with the subject `LFS` in the local-only lane holds every LFS file's real content.
- **Top of the stack**: `heads(merge::)`, normally `@` or its parent.

## Reading the stack

Always allowed, no request needed.

| Question | Command |
| --- | --- |
| Whole stack | `jj log -r 'main::heads(merge::)'` |
| Lane heads | `jj log -r 'merge-'` |
| Lane roots | `jj log -r 'roots(main..merge)'` |
| Lane that contains `X` | `jj log -r 'main..(merge- & X::)'` |
| Bookmarks in lanes | `jj log -r '(main..merge) & bookmarks()'` |
| Work on top of `merge` | `jj log -r 'merge+::'` |
| Local-only markers | `jj log -r '(main..merge) & description(substring:"DO NOT PUSH: local only")'` |
| Never-push commits | `jj log -r '(main..merge | merge::) & (description(substring:"DO NOT") | subject(exact:"LFS"))'` |
| LFS commit | `jj log -r 'subject(exact:"LFS") & ::merge'` |
| Conflicts | `jj log -r 'conflicts() & mutable()'` |

## Rules

- Run a recipe only when Max asks for it. One request covers one recipe: a sync request does not cover an LFS refresh or abandoning landed lanes, so ask before those.
- The recipes are the only exception to the `vcs` skill's rule against rebasing and moving bookmarks.
- Before each recipe, record the current operation: `jj op log -n 1 --no-graph -T 'id.short() ++ "\n"'`. If a step fails or the result looks wrong, stop, report what happened and give Max `jj op restore <id>`. Don't repair it yourself.
- New work goes on top of the stack through the `vcs` skill's `jj new`/`jj commit` flow. It moves into a lane only when Max asks.
- Never describe, rebase, abandon or push `merge`, and never move or delete its bookmark. Only `jj simplify-parents` and lane recipes change its parents.
- Always pair `-A main` with `-B merge`. `-A main` alone rebases every lane onto the inserted commits.
- Push one named bookmark at a time with `jj git push -b <name>`. Never run bare `jj git push`, which pushes every bookmark between the remote and `@`. Never run `jj git push --deleted` unless asked.
- Report conflicts. Resolve them only when asked.

## Recipes

### Sync with main

```sh
jj git fetch
jj rebase -b @ -d main
jj simplify-parents -r merge
jj log -r 'conflicts() & mutable()'
```

`-b @` moves every lane only while `@` is in `merge::`. If `@` is inside a lane, use `jj rebase -b merge -d main` instead.

Then report:

- conflicted commits. If the LFS commit is among them, offer the LFS refresh.
- lanes that landed. Their commits are now empty:
  `jj log -r '(main..merge) & empty() ~ merge ~ description(substring:"DO NOT PUSH")'`.
  Offer the cleanup.
- bookmarks that `jj bookmark list` shows as `(deleted)`, meaning the remote branch was deleted after merge.

### Clean up landed lanes

Only abandon commits that are empty after a sync. A lane with only some empty commits landed partially: report it and ask.

```sh
jj abandon -r '<empty landed commits>'
jj simplify-parents -r merge
```

`jj abandon` deletes local bookmarks that point at the abandoned commits. Never abandon `merge` or a `DO NOT PUSH: local only` marker, even though both are empty.

### Refresh the LFS commit

Run it when the LFS commit is conflicted after a sync, or when Max asks.

```sh
jj log -r 'subject(exact:"LFS") & ::merge'   # exactly one commit: <lfs>
jj new -B <lfs> -m LFS                        # @ = new empty LFS commit below the old one
git lfs pull                                  # writes every LFS file's content into the working copy
jj abandon -r <lfs>
jj new 'exactly(heads(merge::), 1)'           # back to the top; errors if there are several heads, then ask Max
jj log -r 'conflicts() & mutable()'
```

`jj new -B` puts the new commit between the old LFS commit and its parent, and `git lfs pull` fills it from the LFS-tracked files of that parent. Abandoning the old commit rebases the rest of the lane onto the fresh one, which drops the old conflicts.

- `git lfs pull` needs network access to GitHub's LFS storage. If a sandbox blocks it, ask to rerun it unsandboxed.
- If snapshotting refuses files because of `snapshot.max-new-file-size`, stop and report the file names.
- Leaving the empty, undescribed `@` makes jj abandon it automatically. That is expected.
- Plain `jj new 'heads(merge::)'` would silently create a merge commit when there are several heads; `exactly(..., 1)` makes it refuse instead.

### Promote work into a new lane

The commits must be a linear chain and contain no `DO NOT MERGE` commit.

```sh
jj rebase -r '<first>::<last>' -A main -B merge
jj log -r 'conflicts() & mutable()'
jj bookmark create <name> -r <last>
```

- Conflicts mean the work depends on another lane, so it belongs stacked in that lane. Report this and offer `jj op restore <id>`.
- Name the bookmark like Max's existing bookmarks in the repo (`jj bookmark list`). Tell Max the name; it is cheap to rename until it is pushed.
- If Max wants a lane that is not PR-bound yet, skip the bookmark.

### Stack onto an existing lane

```sh
jj log -r 'merge- & <commit in the lane>::'   # <head> of that lane
jj rebase -r '<first>::<last>' -A <head> -B merge
```

The rebase leaves the lane's bookmark on the old head. Then do one of the following:

- **New stacked branch:** `jj bookmark create <name> -r <last>`
- **Extend the existing branch:** `jj bookmark set <lane bookmark> -r <last>`

### Move fixups into their lanes

Fixups are named `fixup <change id>: <description>` (see the `vcs` skill). Max squashes them himself.

```sh
jj log -r 'merge+:: & subject(glob:"fixup *")'
jj rebase -r <fixup> -A <target change id>    # once per fixup
```

If the target carries a bookmark (a lane head or a lower stacked bookmark), the bookmark stays on the target. Move it with `jj bookmark set <bookmark> -r <fixup>`, or the fixup is missing from that branch.

### Add local-only changes

Put the commits into the existing local-only lane:

```sh
jj log -r 'merge- & (description(substring:"DO NOT PUSH: local only")::)'   # <head> of the local-only lane
jj rebase -r '<first>::<last>' -A <head> -B merge
```

If there is no local-only lane yet, or Max wants a separate one, create the marker first. `jj new` prints the change ID of the new commit; that ID is `<marker>`.

```sh
jj new --no-edit -A main -B merge -m 'DO NOT PUSH: local only'
jj rebase -r '<first>::<last>' -A <marker> -B merge
```

### Push a branch

Check what would be pushed. The following must print nothing:

```sh
jj log -r 'main..<bookmark> & (description(substring:"DO NOT") | subject(exact:"LFS") | conflicts() | description(exact:""))'
jj log -r '<bookmark> & (merge | merge+::)'
```

If either prints a commit, stop and report it. Otherwise:

```sh
jj git push -b <bookmark>
```

If jj refuses to create the remote bookmark, pass its hint on to Max instead of trying other flags. Open a PR only when asked: the base is `main`, or the next bookmark down the lane for a stacked branch. Follow the repository's own PR instructions.

## Common mistakes

- `-A main` without `-B merge` rebases every lane.
- `jj rebase -b @` with `@` inside a lane moves only that lane.
- Bare `jj git push` pushes every bookmark in the stack.
- Abandoning "all empty commits" also hits `merge` and the local-only markers.
- `jj abandon` deletes bookmarks on the abandoned commits.
- After `-A <commit>`, a bookmark on that commit still points at it, not at the inserted commits.
