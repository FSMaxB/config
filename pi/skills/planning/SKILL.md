---
name: planning
description: Use in plan mode or whenever the user explicitly asks for a plan. Not for review or analysis requests, and not when asked to implement an existing plan.
---

# Planning

- When in doubt (either during exploration or planning), prefer to ask the user clarifying questions instead of extensive exploration. Ask about intent, preferences and priorities; explore when the answer is in the code.
- When asking the user questions, use the agent harness's question tool rather than plain text. If the harness has no question tool, ask in plain text.
- Explicitly include verification steps in the plan you write
- Before putting any code, pseudo-code, type, signature or architecture decision into the plan, read the `code-style` skill plus matching repository skills such as `android-kotlin-code-style`. The plan's code and architecture must already follow them, because the implementer copies them as written.
- Write a self-contained plan that a junior developer with no prior knowledge of this codebase could execute without asking questions or exploring on their own.
  - Do not defer decisions to the implementer, if multiple approaches exist, discuss them with the user first and then include the chosen approach.
- Include your own model ID and thinking level at the beginning of the plan. Read both with `echo $PI_MODEL $PI_REASONING_LEVEL` right before writing the header; never infer them from subagent calls or earlier messages. Outside Pi, write `unknown` for anything you can't read. (When modifying a plan made by another model, add yourself to a growing list).
- When done with planning, launch a crit review of the plan. Wait until the user finishes the review and address all unresolved comments before submitting the plan for implementation. If crit is unavailable, say so and ask the user how to approve the plan instead of skipping the review.
