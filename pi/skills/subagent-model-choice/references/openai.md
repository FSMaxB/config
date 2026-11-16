# OpenAI model tiers

OpenAI publishes model x effort pairings rather than a per-model table.

| Tier | Model | Suggested pairings |
| --- | --- | --- |
| cheap | GPT-6 Luna (`gpt-6-luna`), GPT-5.6 Luna | `low`: fine-grained edits, simple extraction. `medium`: coordinated updates from a clear brief. `xhigh`: cross-app context gathering with clear constraints. |
| mid (efficient) | GPT-6.1 Terra (`gpt-6.1-terra`) | Try for scoped code fixes with regression tests, visual reasoning, precise computer use, and writing from supplied material. Start at `medium` (default); compare with Sol at the same effort and keep the lightest setting that passes verification. |
| mid | GPT-6.1 Sol (`gpt-6.1-sol`) | Near-Astra performance at lower cost for complex coding, computer use, and professional work. Start at `medium` (default); use `low` for focused tasks, and evaluate `high` / `xhigh` for difficult analysis or review. Reserve `max` for measured gains over `xhigh`. |
| frontier | GPT-6 Astra (`gpt-6-astra`) | `medium`: ambitious projects needing broad context. `xhigh`: demanding analysis. Does not accept `none`. Uses fewer output tokens per task than earlier models, so per-task cost can be lower than its per-token price suggests. |

GPT-6.1 Terra costs $1 / $5 per million input / output tokens at standard
rates. Prompts above 272K input tokens cost 2x input and 1.5x output for the
full request. It supports `none`, `low`, `medium` (default), `high`, `xhigh`,
and `max`; `none` allows non-reasoning runs. Use Terra as an efficient
mid-tier option for well-specified, verifiable tasks, not as a blanket
replacement for Luna's cheapest lookups or Sol's complex technical work.
For code fixes, require regression tests; for computer use, verify saved
state and the completion report rather than trusting the report alone.

GPT-6.1 Sol supports `low`, `medium`, `high`, `xhigh`, and `max`, but not
`none` or `minimal`: choose at least `thinkingLevel: "low"`. Both GPT-6.1
Terra and Sol require the Responses API for tool calling. Confirm the
configured provider uses Responses before dispatching a tool-using
subagent with either model.

Prefer GPT-6.1 Sol over GPT-6 Sol (`gpt-6-sol`) for new mid-tier dispatches
when it is configured. Prefer GPT-6.1 Terra over GPT-5.6 Terra for
Terra-suited tasks when configured. Older GPT-6 Sol and GPT-5.6 Terra remain fallbacks when the
corresponding GPT-6.1 models are unavailable. Compare Sol 6.1 with Astra
on the same task before paying for the frontier tier.
