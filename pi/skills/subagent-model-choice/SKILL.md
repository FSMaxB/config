---
name: subagent-model-choice
description: Use before every call to Pi's subagent tool, and whenever choosing a model or thinking level for a subagent.
---

# Subagent model and thinking level

A subagent gets its own context window and its own bill. The main session
picks its model and thinking level, so every dispatch is a cost decision.
The default is to inherit; deviate deliberately and for a reason you can name.

## Procedure

1. Classify the task with the table in [Task classes](#task-classes).
2. Pick the tier (cheap, mid, frontier) from that row, then map the tier to a
   concrete model from the session's provider using [Model tiers](#model-tiers).
   Omit `model` when the row says "inherit".
3. Pick `thinkingLevel` from the same row. Omit it to inherit the session's level.
4. Check [Harness rules](#harness-rules): same provider family as the session,
   local-only when the session is local, levels the model lacks get clamped.
5. Write the brief so the cheaper model can succeed: state everything already
   known, name the files to start from, and say what the report must contain.
   A weaker model with a precise brief beats a stronger model with a vague one.

## Task classes

| Task | Tier | Thinking |
| --- | --- | --- |
| Mechanical fact-finding: where is X defined, who calls Y, list the files that match | cheap | `low` |
| Exploration that needs judgment: how does this subsystem work, which of these helpers fits, summarize the design | cheap, then mid | `high` on cheap, `medium` on mid |
| Scoped implementation with a clear spec and tests to run | mid | `medium` |
| Debugging, root-cause analysis, tricky refactor across modules | inherit | `high` |
| Review or verification of a change (correctness, security) | inherit | `high` or `xhigh` |
| Long-running autonomous work (hours, many tool calls) | frontier | `high` / `xhigh` |
| Many parallel, independent lookups | cheap | `low` or `minimal` |

- Fact-finding whose list must be exhaustive: use `medium`. At `low`, Haiku
  5.5 is more likely to skip a search or stop early in a long agent prompt.
- Exploration: move from the cheap tier to the mid tier at `medium` when the
  report misses connections. Frontier models are wasted on reading.
- Implementation judged by tests: the cheap tier at `medium` is worth a try.
  Tell it to run the check, since it sometimes reports a change done without
  running one. Raise to `high` if the first attempt fails tests.
- Debugging: do not save money here; a wrong answer costs more than the tokens.
- Review: use `xhigh` only when the model supports it natively.
- Long-running autonomous work: only when the task genuinely needs it.

Three overriding rules from Anthropic's measurements:

- **Lowering thinking is the cheapest lever.** Tuning effort on the same
  model is usually better than switching models. Try a lower level before
  reaching for a cheaper tier, and try a cheaper tier at `low` before giving
  up on it.
- **Verifiable output can start cheap.** When a test suite or checker judges
  the result, run at `low` and re-run only the failures at `high`. On
  Anthropic's coding benchmark this held the pass rate at about half the cost.
- **Escalate one tier at `low`.** When a report falls short and effort is
  already back at the default, Anthropic's next step is the next tier up at
  `low`, not the same tier at `xhigh` or `max`.

## Thinking levels

Pi's levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
Pi translates them into the provider's setting; a level the model does not
support is clamped to the nearest one it does.

| Level | Anthropic (`effort`) | OpenAI (`reasoning.effort`) | Google (`thinking_level`) |
| --- | --- | --- | --- |
| `off` / `minimal` | Opus 5.5 and Fable 5.2 always think, so this clamps up. Haiku 5.5 and Sonnet 5.5 accept thinking off at `high` or below (`disabled` and `between_tools` respectively) | `none` (GPT-6.1 Terra, GPT-6 Sol and Luna; GPT-6.1 Sol and Astra require at least `low`) / `minimal` (supported GPT-5.x models; GPT-6 maps to `low`) | `minimal` (Flash-Lite, some Flash) |
| `low` | Most efficient; "simpler tasks ... such as subagents". On Haiku 5.5: chat, short tool tasks, high-volume requests; in long agent prompts it may skip a search, stop early, or skip a check | Tool use, search, execution-oriented coding | `low` |
| `medium` | Balanced; default on Opus 5.5 and Haiku 5.5 | Default for most workloads; agentic coding, research | `medium` (Flash default) |
| `high` | Default on Fable, Sonnet, older Opus. On Haiku 5.5: knowledge work, longer agent tasks, strict instruction following | Hard reasoning, complex debugging | `high` (Pro default) |
| `xhigh` | Long-horizon work; native only on Fable 5.x, Opus 4.7+, Sonnet 5+, Haiku 5.5; clamps to `high` elsewhere. On Haiku 5.5 compare against Sonnet 5.5 first | Long runs; only with evals showing a gain | clamps to `high` |
| `max` | No token constraint; often overthinks structured tasks | Only if `xhigh` measurably falls short | clamps to `high` |

Effort applies to every output token, not only thinking: at `low` a model
makes fewer, terser tool calls and skips preamble, which is exactly what a
lookup subagent should do. At `high` it explains plans and summarizes more,
which inflates the report the main session has to read.

Local models (LM Studio, llama.cpp, qmlx) mostly ignore the level or only
distinguish on/off. Choose by model, not by level, and expect `thinkingLevel`
to be a no-op unless the server exposes reasoning effort explicitly.

## Model tiers

Before picking a model, read the tier table for the session's provider
(`echo $PI_PROVIDER`):

- Anthropic, including the `pi-claude` bridge: `references/anthropic.md`
- OpenAI: `references/openai.md`
- Google: `references/google.md`

For other providers and local models, use the `subagent` tool
description: it lists the models valid for the current session with
one-line guidance per model (from the extension's config). Trust that list
over the reference files when they disagree: it reflects what is actually
configured. For local models, the strongest local coder is the
only sensible "cheap" option, and the session model is the ceiling.

## Harness rules

- Omitting `model` inherits the session model and is always valid.
- A cloud subagent must belong to the session model's provider family;
  the tool rejects cross-provider picks and lists the valid ones.
- A session on a local model may only dispatch local subagents. Prefer
  omitting `model` and lowering `thinkingLevel` instead of switching.
- `thinkingLevel` is inherited when omitted. Lowering it on the inherited
  model is the cheapest way to scale effort down.
- Independent subagent tasks go in one parallel call; dependent ones run
  in sequence with the earlier report pasted into the later brief.

## Anti-patterns

- Inheriting a Fable-class session model for "find where X is defined".
  That is a Haiku task at `low`.
- Sending Haiku 5.5 at `low` on a long brief and trusting the report as
  exhaustive. At `low` it is more likely to skip a search or stop early;
  Anthropic measured that `medium` roughly halves early stopping. Use
  `medium` when completeness matters.
- Sending a cheap model into a debugging task to save money, then spending
  the main session's tokens to redo it. Token spend explains most of the
  variance in agent performance (Anthropic's multi-agent research
  evaluation); starving a hard task is the expensive option.
- Spawning many subagents for a simple query. Anthropic's scaling rule:
  simple fact-finding is one agent with 3 to 10 tool calls; a direct
  comparison is 2 to 4 subagents with 10 to 15 calls each; only genuinely
  broad research needs more than that.
- Choosing `max` by default. On most workloads it adds cost for small
  gains and can overthink structured tasks.
- Comparing models per token. Compare per completed task; a newer model at
  `low` often beats an older one at `high` for less.

## Sources

Anthropic sources checked 2026-10-08 (Haiku 5.5 release), models
overview rechecked 2026-11-16 (Fable 5.2); OpenAI
model selection and GPT-6.1 Terra sources checked 2026-10-27 (other OpenAI
sources checked 2026-09-30); Google sources checked 2026-09-29.

- Anthropic, Choosing the right model: https://platform.claude.com/docs/en/about-claude/models/choosing-a-model
- Anthropic, Models overview (prices, defaults): https://platform.claude.com/docs/en/models/overview
- Anthropic, Pricing (Haiku 5.5 prompt-length tiers): https://platform.claude.com/docs/en/about-claude/pricing
- Anthropic, Claude Haiku 5.5 overview: https://platform.claude.com/docs/en/models/haiku-5-5/overview
- Anthropic, Prompting Claude Haiku 5.5 (effort levels, early stopping, verification): https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-haiku-5-5
- Anthropic, Effort: https://platform.claude.com/docs/en/build-with-claude/effort
- Anthropic, Optimizing for cost and intelligence: https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence
- Anthropic, How we built our multi-agent research system: https://www.anthropic.com/engineering/multi-agent-research-system
- OpenAI, Model selection: https://developers.openai.com/api/docs/guides/model-selection
- OpenAI, Reasoning (effort table): https://developers.openai.com/api/docs/guides/reasoning
- OpenAI, Using GPT-6: https://developers.openai.com/api/docs/guides/latest-model
- OpenAI, GPT-6.1 Terra (pricing, supported effort levels and tool calling): https://developers.openai.com/api/docs/models/gpt-6.1-terra
- OpenAI, GPT-6.1 Sol (supported effort levels and tool calling): https://developers.openai.com/api/docs/models/gpt-6.1-sol
- Google, Gemini thinking: https://ai.google.dev/gemini-api/docs/thinking
