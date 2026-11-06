---
name: planning
description: Use in plan mode or whenever Max explicitly asks for a plan. Not for review or analysis requests, and not when asked to implement an existing plan.
---

# Planning

- This skill applies in plan mode or when I explicitly ask for a plan. Review and analysis requests are not plans; answer them directly without the steps below.
- If you are explicitly asked to implement a plan, ignore this entire skill and start implementing.
- When in doubt (either during exploration or planning), prefer to ask me clarifying questions instead of extensive exploration. Ask about intent, preferences and priorities; explore when the answer is in the code.
- When asking me questions, use the agent harness's question tool rather than plain text. If the harness has no question tool, ask in plain text.
- Explicitly include verification steps in the plan you write
- Write a self-contained plan that a junior developer with no prior knowledge of this codebase could execute without asking questions or exploring on their own.
  - Do not defer decisions to the implementer, if multiple approaches exist, discuss them with me first and then include the chosen approach.
  - When describing concrete code changes, prefer small code examples or pseudo-code over bullet points.
- Include your own model ID and thinking level at the beginning of the plan. Read both with `echo $PI_MODEL $PI_REASONING_LEVEL` right before writing the header; never infer them from subagent calls or earlier messages. Outside Pi, write `unknown` for anything you can't read. (When modifying a plan made by another model, add yourself to a growing list).
- When done with planning, launch a crit review of the plan. Wait until I finish the review and address all unresolved comments before submitting the plan for implementation. If crit is unavailable, say so and ask me how to approve the plan instead of skipping the review.
