---
name: notes
description: 'Use when the user asks to keep notes, a notes document or a running write-up, and whenever work continues on a topic that has a `DO NOT MERGE: notes on ...` commit.'
---

# Notes

A notes document is a markdown file that records what a session established, so a later session can continue from it without re-deriving anything. It lives in its own `DO NOT MERGE: notes on <topic>` commit in the local-only lane of the megamerge stack (see the `jj-megamerge` skill), and every update is a fixup commit next to it. The user squashes the fixups.

The workflow needs a `merge` bookmark (`jj log -r 'present(merge)'`) and `@` inside `merge::`, so the notes file is in the working copy. Otherwise, ask the user where the notes should live.

## Keeping notes up to date

- Update the notes automatically, in the same turn a fact is established. Never ask whether to add something; tell the user in one line what changed in the notes.
- Asking is still required before acting on the notes, e.g. implementing an item from the TODO section.
- Edit in place. When a finding supersedes an earlier statement, rewrite that statement instead of appending a contradiction. Strike through answered open questions (`~~...~~`) and point to the section that answers them.
- Record evidence with each finding: `file:line`, commit hashes, PR links, the exact command and the numbers it printed. Mark what is verified, with the date, and what is only suspected.
- Prefer facts the next session cannot cheaply re-derive: dead ends and why they failed, environment quirks, IDs of test data, commands that worked.
- Keep secrets and raw production data (message contents, tokens, user data dumps) out of the file. Store them outside the repository and reference the path; note that such files must be deleted when done.
- Do not offer or open a tuicr review for notes commits or their fixups.

## Layout of a new notes file

Put it at the repository root as `<topic>_notes.md`, unless the user names a path.

```markdown
# <Topic>: notes

<One or two sentences: goal and start date.>

## Prompt for a fresh agent

> Read this document before working on <topic>. Treat the findings as verified;
> re-check one only if the user disputes it or the code has moved since its date.
> Keep this document up to date automatically, without asking: record every
> established finding, add or sharpen TODO items, strike through answered
> questions. It lives in the `DO NOT MERGE: notes on <topic>` commit of the
> local-only lane; commit each update as `fixup <change id>: <what changed>`
> (see the `notes` skill).

Entry points: <paths, tools, related docs>

## Findings

## Open questions

## TODO
```

Drop the sections the topic does not need. Group findings under descriptive headings rather than in chronological order.

## Finding the notes commit

```sh
jj log -r '(main..merge | merge::) & subject(glob:"DO NOT MERGE: notes*")'
```

Below, `<notes>` is the 8-character change ID of the matching commit (`change_id.short(8)`). If several match, pick the one for the current topic or ask.

If the notes commit sits on top of `merge` instead of in the local-only lane, ask the user before moving it there with the steps in "Starting notes". Until the user answers, commit fixups on top of the stack with plain `jj commit <file> -m 'fixup <notes>: ...'`.

## Starting notes

Record the current operation first (`jj op log -n 1 --no-graph -T 'id.short() ++ "\n"'`); if a step fails or the result looks wrong, stop and give the user `jj op restore <id>`.

```sh
jj status                                              # the notes file must be the only change you commit
jj commit <file> -m 'DO NOT MERGE: notes on <topic>'
jj log -r @- --no-graph -T 'change_id.short(8) ++ "\n"'                                                    # <notes>
jj log -r 'merge- & (description(substring:"DO NOT PUSH: local only")::)'                                 # <lane head>
jj rebase -r <notes> -A <lane head> -B merge
jj log -r 'conflicts() & mutable()'
```

If the lane-head query returns nothing, there is no local-only lane yet: create the marker as in the `jj-megamerge` skill's "Add local-only changes" recipe. If it returns several commits, ask which lane to use.

## Updating notes

One fixup per update. The subject says what changed, e.g. `fixup <notes>: record that fix-skipped leaves the unread count alone`.

```sh
jj op log -n 1 --no-graph -T 'id.short() ++ "\n"'          # <op>, for jj op restore
jj status                                              # right before committing
jj diff <file>                                         # only your edits to the notes file
jj commit <file> -m 'fixup <notes>: <what changed>'
jj log -r @- --no-graph -T 'change_id.short(8) ++ "\n"'                                                    # <fixup>
jj log -r 'heads(<notes>:: & ::merge & (<notes> | subject(glob:"fixup <notes>*")))'                         # <tip>
jj rebase -r <fixup> -A <tip>
jj log -r 'conflicts() & mutable()'
```

- `<tip>` is the notes commit or its newest fixup in the lane, so fixups stay in order and each one applies cleanly.
- `-A <tip>` without `-B` is safe here: `<tip>` is inside a lane, so its only child is the next lane commit or `merge`.
- This rebase is the one exception to the `vcs` skill's rule against rebasing without asking. It covers notes fixups only.
- If `jj diff <file>` shows edits that are not yours (the user or another agent writing the same file), ask before committing them.
- If the rebase reports a conflict, stop and give the user `jj op restore <op>`.
