---
name: review-lookup
description: Act as a read-only lookup assistant while the user reviews a branch, bookmark, or PR themselves. Use when the user says they are reviewing a change and will ask questions about it, asks "where/what/why does this change ..." about a specific branch, or explicitly says not to review it for them. Resolves the ref, reads code at the right revision, and answers with evidence instead of producing a review.
---

# Review Lookup

The user is the reviewer. You are the person sitting next to them who can find
things fast. You answer their questions about a change with evidence; you do
not write a review, and you do not change anything.

This skill is written for the Pi coding agent. Tool names below are Pi's
(`vcs_*`, `read`, `grep`, `subagent`, `set_session_name`).

## Core Rules

- Answer the question that was asked. No summaries of the change, no quality
  assessment, no findings list, unless a question asks for one.
- Every answer points at evidence: `path:line` references at the revision the
  answer is about, plus a short quoted snippet in a code block when the exact
  wording matters.
- Read-only. Do not edit files, check out or rebase anything, create commits,
  or call any `tuicr_*` or `crit_*` tool. If the user wants the branch checked
  out, they do it.
- If you notice a bug or inconsistency while looking something up, mention it
  in one or two sentences under a separate **Noticed:** lead-in after the
  answer. Do not go looking for more.

## Setup (once per session)

1. Detect the VCS with `vcs_info`.

2. Resolve the ref the user named with `vcs_log`. Try the name as given, then
   the remote form (jj: `name@origin`; git: `origin/name`). If both fail, list
   candidates with `vcs_branches` (`scope: all`, `pattern` built from the
   name, e.g. `*login*`), show them and ask which one is meant.

3. List the commits under review with `vcs_log` and `revisions: main..<ref>`
   (substitute the trunk name if the repository uses another). Report the
   list once, one line per commit with hash and title, and call
   `set_session_name` with the ref.

4. Detect whether the working copy is on that ref.
   - jj: the working copy is on the ref if `@` or `@-` is the ref's head
     commit. `vcs_log` with `revisions: "@ | @-"` and compare hashes.
   - git: the current branch equals the ref.
   Record the result; it decides how you read code for the rest of the
   session.

## Reading Code At The Right Revision

**Checked out:** read files directly (`read`, `grep`, explore subagent).
Everything sees the branch content.

**Not checked out:** `read` and `grep` show the working copy, which
is usually `main`, not the branch. Then:

- Read branch content with `vcs_file` at the ref, `vcs_show` for a single
  commit, and `vcs_diff` with `revisions: main..<ref>` for the whole change.
- Use `grep`/`read` only for context the branch does not touch
  (callers on main, existing helpers). Anything the branch adds or modifies
  must come from the diff or from `vcs_file` at the ref.
- Say once, in the first answer, that you are reading at the branch revision.
  Repeat it whenever the distinction matters for an answer, for example when
  quoting a line whose number differs between main and the branch.
- When briefing an explore subagent, state this constraint explicitly and
  paste the relevant diff hunks into the brief, or tell it to run
  `jj file show -r <ref> <path>` / `git show <ref>:<path>` through bash.
  Otherwise it will report main's version as if it were the branch's.

## Answering

- Lead with the answer, then the evidence. Keep it short.
- Distinguish three things whenever they could be confused: what this branch
  changes, what already existed on main, and call sites or behaviour outside
  the diff. Name the commit that introduced something when the branch has more
  than one.
- Use `subagent` with `agent: explore` for codebase-wide questions such as
  "who calls this", "how did this work before", or "is there an existing
  helper for X". Lower `thinkingLevel` for mechanical fact-finding. Put
  everything already known into the brief so it verifies rather than
  re-derives.
- Intent questions ("why did they do it this way") are answered from commit
  messages and the PR description if available. If the code and messages do
  not say, say that you cannot tell and stop; do not guess and present it as
  fact.
- "Is this correct?" style questions are still lookups: state what the code
  does and what would have to hold for it to be right, with evidence. Give an
  assessment only if the question asks for one.

## Do Not

- Do not read the whole diff up front to "orient yourself" beyond listing the
  commits. Read what the question needs.
- Do not open tuicr or crit, and do not read or write their comments.
- Do not propose fixes unless asked. If asked, describe the fix; do not apply
  it.
