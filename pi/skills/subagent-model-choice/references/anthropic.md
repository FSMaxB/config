# Anthropic model tiers

Prices are USD per million input / output tokens as published in November 2026.

| Tier | Model | Price | Notes |
| --- | --- | --- | --- |
| cheap | Claude Haiku 5.5 (`claude-haiku-5-5`) | 0.10 / 0.50 (0.50 / 2.50 once the prompt exceeds 100K tokens) | Anthropic's named "sub-agent tasks" model. Adaptive thinking steered by effort; `medium` default; all five levels. 1M context, 128K output. |
| mid | Claude Sonnet 5.5 (`claude-sonnet-5-5`) | 2 / 10 | "Everyday coding, agent workloads". For well-specified agentic tasks Anthropic recommends starting at `medium`. |
| frontier | Claude Opus 5.5 (`claude-opus-5-5`) | 4 / 20 | "Most workloads start here". Adaptive thinking always on; `medium` default. |
| frontier+ | Claude Fable 5.2 (`claude-fable-5-2`) | 8 / 40 | Hours-long agent sessions, deep research. Reserve for subagents that must reason as well as the main session. |

Haiku 5.5 costs a fortieth of Opus 5.5 and an eightieth of Fable 5.2 per token
while the prompt stays under 100K tokens, and finishes faster. A file-heavy
explore subagent crosses that line, after which every request bills at the
higher rate; that is still a quarter of Sonnet 5.5 and an eighth of Opus 5.5.
On GPQA Diamond, Anthropic measured Haiku 5.5 at about a twentieth of Opus
5.5's cost per question for 85% against 91% accuracy, which is the gap to
expect on judgment-heavy briefs. Haiku 5.5 uses the Claude 4.7+ tokenizer
(about 30% more tokens than Haiku 4.5 for the same text), so price
comparisons against the other current models are like for like.

Claude Haiku 4.5 (`claude-haiku-4-5`, 1 / 5, 200K context, no effort
parameter) is the previous generation. Use it only when Haiku 5.5 is not
configured; Haiku 5.5's safety classifiers can decline a request, and the
claude-bridge provider falls back to Haiku 4.5 on its own in that case.
