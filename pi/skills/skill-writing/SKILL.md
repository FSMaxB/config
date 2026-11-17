---
name: skill-writing
description: Use when creating, editing, renaming or reviewing an agent skill (a SKILL.md file or the files bundled with it), or when asked to turn a workflow, a correction or repeated instructions into a skill.
---

# Skill writing

## Before writing

- Collect the concrete failures the skill has to fix: corrections from the conversation, mistakes the user describes, or a baseline run (see Testing). Write guidance for those, not for imagined cases.
- Check the existing skills for overlap. Extend a skill that already covers the topic instead of adding a near-duplicate.
- Rules that apply to every task belong in AGENTS.md or CLAUDE.md, not in a skill. Rules a script, linter or test can enforce belong in that tool.
- Follow the repository's instructions on where skills live and how they are installed. Without any, put a user skill in the harness's global skill directory as `<name>/SKILL.md`.

## Name

- Lowercase letters, digits and single hyphens, at most 64 characters, identical to the directory name.
- Name the activity or topic in the style of the neighbouring skills (`code-style`, `planning`, `skill-writing`). Avoid vague names such as `helpers` or `tools`.

## Description

The description is always in context and only decides whether the skill gets loaded. It names the condition for loading the skill and nothing else. Do not summarize what the skill says or does: an agent that reads a summary acts on it and skips the body.

- Start with "Use when", "Use before" or "Use whenever", followed by concrete situations: tasks, user phrasings, file types, tools, commands, error messages.
- State the timing when it matters. "Before committing" loads the skill in time; "when committing" can load it after the commit.
- Cover the synonyms a task or user would use. Models load skills too rarely rather than too often, so lean towards broad triggers.
- Add an exclusion when a neighbouring task looks similar ("Not for review requests").
- Keep it to one or two sentences. Hard limit: 1024 characters.

Bad, because it summarizes the content:

```yaml
description: Review code or plans the way the user does. Covers comment format and tone, verdicts and what to hunt for.
```

Good, because it names only the condition:

```yaml
description: Use whenever you review a diff, commit, branch, pull request or plan for the user, or draft review comments on the user's behalf.
```

## Body

- Write only what a capable model would not know or do on its own. Cut background, definitions and motivation.
- One imperative rule per bullet. Lead with the rule. Add a short reason only when the rule is non-obvious or easy to misapply at its edges.
- No ALL-CAPS, "MUST", "CRITICAL" or "IMPORTANT": current models follow plain instructions, and emphasis makes them over-apply a rule.
- Pick the form that fixes the failure:
  - The model knows the rule but skips it: state the prohibition and name the excuse it uses.
  - The output has the wrong shape: describe the target shape (its parts, in order) or give a template, instead of listing what to avoid.
  - The output misses an element: make it a required slot in the template.
  - The behaviour depends on the situation: write a conditional on something observable ("If the repository has a `merge` bookmark, ..."), not a general rule plus exceptions.
- Do not soften a rule with "unless it matters" or similar. Write a real exception as its own conditional.
- Match the freedom to the fragility: exact commands for fragile or order-dependent steps, heuristics where several approaches work.
- Give one default instead of a menu of options, plus the escape hatch for when the default does not fit.
- Use one term per concept throughout the skill.
- Prefer one concrete example over an abstract description. For style rules, a bad/good pair works best.
- Leave out dates, "currently" claims that expire and stories of how a problem was found.
- Refer to other skills by name ("read the `vcs` skill"), not by path.
- In a skill shared between harnesses, prefix harness-specific lines with the harness ("Pi only: ...").

## Size and bundled files

- A loaded body stays in context for the rest of the session. Keep SKILL.md as short as its rules allow; 500 lines is the upper limit.
- Move material that only some tasks need into a file next to SKILL.md (for example `references/<topic>.md`). In SKILL.md, say exactly when to read it: "Before adding a flowchart, read `references/flowcharts.md`."
- Link every bundled file directly from SKILL.md; do not chain references through other bundled files. Start files longer than 100 lines with a table of contents.
- Put deterministic or fragile operations into a script under `scripts/`. Say whether to run it or read it, run it through its interpreter (`bash scripts/check.sh`), and let it handle its own errors with clear messages.
- Use relative paths from the skill directory, with forward slashes.

## Frontmatter

- `name` and `description` are required. Add `disable-model-invocation: true` only when the skill should load solely through `/skill:<name>`, and `license` for forked skills.
- Do not use harness-specific fields (such as Claude Code's `when_to_use` or `paths`) in a skill shared between harnesses.

## Testing

After drafting a new skill or changing a skill's behaviour, propose a test and ask the user before running it, since each run costs a subagent call:

- Body test: one realistic task, run in two subagents. The baseline subagent is told not to read the skill (when editing, it reads a copy of the old version saved before the edit); the other is told to read the new SKILL.md first. Compare both outputs against the failures collected before writing.
- Trigger test, after a name or description change: give a subagent a realistic task that does not mention the skill and check whether it loads the skill on its own. Also try a neighbouring task that should not load it.

Read every output yourself. If the baseline already behaves correctly, the guidance is not needed: remove it. One run per side is a smoke test; offer more runs when the results are unclear.

## Finishing

- Re-read the finished skill:
  - The description names only the loading condition.
  - Every line changes behaviour; delete lines the model would follow without being told.
  - Every bundled file is linked from SKILL.md together with the situation that calls for it.
- Pi only: Pi reads names and descriptions at startup, so run `/reload` or restart Pi after changing them. Body changes apply on the next read.
