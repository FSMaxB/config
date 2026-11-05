---
name: exploration
description: Use before reading code to answer a question, investigate a bug or prepare a change or plan.
---

# Exploration

- Delegate complex codebase exploration that requires reading lots of code to an explore subagent (when the harness provides one).
- Write the subagent brief so it contains everything already known, so the subagent verifies instead of re-deriving it.
- For mechanical fact-finding, run the subagent on a cheaper model or a lower thinking level than the main session instead of inheriting the session model. Pick the cheaper model from whatever provider the session uses.
- Pi only: before calling the `subagent` tool, read the `subagent-model-choice` skill to pick `model` and `thinkingLevel` for the task class.
- Pi only: Prefer `codemode` over chaining shell commands.
