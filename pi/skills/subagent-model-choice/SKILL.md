---
name: subagent-model-choice
description: Pick the model and thinking level for a subagent before dispatching it. Use whenever you call Pi's subagent tool and have to decide whether to inherit the session model, drop to a cheaper tier, or change the thinking level. Covers Anthropic, OpenAI, Google and local models, and the subagent tool's rules that limit the choice.
---

# Subagent model and thinking level

A subagent gets its own context window and its own bill. The main session
picks its model and thinking level, so every dispatch is a cost decision.
The default is to inherit; deviate deliberately and for a reason you can name.

Written for the Pi coding agent's `subagent` tool and its `model` and
`thinkingLevel` parameters.

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

| Task | Tier | Thinking | Why |
| --- | --- | --- | --- |
| Mechanical fact-finding: where is X defined, who calls Y, list the files that match | cheap | `low` | Tool calls dominate; reasoning adds little. Anthropic and OpenAI both name "subagents" and "search / retrieval" as the `low` effort use case. |
| Exploration that needs judgment: how does this subsystem work, which of these helpers fits, summarize the design | mid | `medium` | Needs synthesis across files. Cheap models miss connections; frontier models are wasted on reading. |
| Scoped implementation with a clear spec and tests to run | mid | `medium` | OpenAI's `medium` row: "agentic coding ... delegating long-horizon work". Raise to `high` if the first attempt fails tests. |
| Debugging, root-cause analysis, tricky refactor across modules | inherit | `high` | Anthropic and OpenAI both put "complex debugging, hard reasoning" at `high`. Do not save money here; a wrong answer costs more than the tokens. |
| Review or verification of a change (correctness, security) | inherit | `high` or `xhigh` | OpenAI lists "security and code review" under `xhigh`; Anthropic's `xhigh` is for long-horizon agentic work. Use `xhigh` only when the model supports it natively. |
| Long-running autonomous work (hours, many tool calls) | frontier | `high` / `xhigh` | Anthropic: Fable-class models for "agent sessions that run for hours". Only when the task genuinely needs it. |
| Many parallel, independent lookups | cheap | `low` or `minimal` | Multi-agent runs use about 15x the tokens of a chat; keep each worker cheap. |

Two overriding rules from Anthropic's measurements:

- **Lowering thinking is the cheapest lever.** Tuning effort on the same
  model is usually better than switching models. Try a lower level before
  reaching for a cheaper tier, and try a cheaper tier at `low` before giving
  up on it.
- **Verifiable output can start cheap.** When a test suite or checker judges
  the result, run at `low` and re-run only the failures at `high`. On
  Anthropic's coding benchmark this held the pass rate at about half the cost.

## Thinking levels

Pi's levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
Pi translates them into the provider's setting; a level the model does not
support is clamped to the nearest one it does.

| Level | Anthropic (`effort`) | OpenAI (`reasoning.effort`) | Google (`thinking_level`) |
| --- | --- | --- | --- |
| `off` / `minimal` | Not available on adaptive-thinking models (Opus 5.5, Fable 5.1 always think); clamps up | `none` (Sol, Luna only; Astra rejects it) / `minimal` (GPT-5.x; GPT-6 maps to `low`) | `minimal` (Flash-Lite, some Flash) |
| `low` | Most efficient; "simpler tasks ... such as subagents" | Tool use, search, execution-oriented coding | `low` |
| `medium` | Balanced; default on Opus 5.5 | Default for most workloads; agentic coding, research | `medium` (Flash default) |
| `high` | Default on Fable, Sonnet, older Opus | Hard reasoning, complex debugging | `high` (Pro default) |
| `xhigh` | Long-horizon work; native only on Fable 5.x, Opus 4.7+, Sonnet 5+; clamps to `high` elsewhere | Long runs; only with evals showing a gain | clamps to `high` |
| `max` | No token constraint; often overthinks structured tasks | Only if `xhigh` measurably falls short | clamps to `high` |

Effort applies to every output token, not only thinking: at `low` a model
makes fewer, terser tool calls and skips preamble, which is exactly what a
lookup subagent should do. At `high` it explains plans and summarizes more,
which inflates the report the main session has to read.

Local models (LM Studio, llama.cpp, qmlx) mostly ignore the level or only
distinguish on/off. Choose by model, not by level, and expect `thinkingLevel`
to be a no-op unless the server exposes reasoning effort explicitly.

## Model tiers

Prices are USD per million input / output tokens as published in September 2026.

### Anthropic

| Tier | Model | Price | Notes |
| --- | --- | --- | --- |
| cheap | Claude Haiku 4.5 (`claude-haiku-4-5`) | 1 / 5 | Anthropic's named "sub-agent tasks" model. No effort parameter; use `thinkingLevel` for its thinking budget. 200K context. |
| mid | Claude Sonnet 5.5 (`claude-sonnet-5-5`) | 2 / 10 | "Everyday coding, agent workloads". For well-specified agentic tasks Anthropic recommends starting at `medium`. |
| frontier | Claude Opus 5.5 (`claude-opus-5-5`) | 4 / 20 | "Most workloads start here". Adaptive thinking always on; `medium` default. |
| frontier+ | Claude Fable 5.1 (`claude-fable-5-1`) | 10 / 50 | Hours-long agent sessions, deep research. Reserve for subagents that must reason as well as the main session. |

Haiku costs a quarter of Opus and a tenth of Fable per token, and finishes
faster. A Haiku explore subagent is nearly free next to the session that
spawned it.

### OpenAI

OpenAI publishes model x effort pairings rather than a per-model table.

| Tier | Model | Suggested pairings |
| --- | --- | --- |
| cheap | GPT-6 Luna (`gpt-6-luna`), GPT-5.6 Luna | `low`: fine-grained edits, simple extraction. `medium`: coordinated updates from a clear brief. `xhigh`: cross-app context gathering with clear constraints. |
| mid | GPT-6 Sol (`gpt-6-sol`), GPT-5.6 Terra | `low`: focused editing, fact-checking. `medium`: everyday coding and research. `xhigh`: thorough verification and careful review of code. |
| frontier | GPT-6 Astra (`gpt-6-astra`) | `medium`: ambitious projects needing broad context. `xhigh`: demanding analysis. Does not accept `none`. Uses fewer output tokens per task than earlier models, so per-task cost can be lower than its per-token price suggests. |

### Google

| Tier | Model | Default thinking |
| --- | --- | --- |
| cheap | Gemini Flash-Lite | `minimal` |
| mid | Gemini Flash | `medium` |
| frontier | Gemini Pro | `high` |

### Other providers and local

The `subagent` tool description lists the models valid for the current
session with one-line guidance per model (from the extension's config).
Trust that list over this file when they disagree: it reflects what is
actually configured. For local models, the strongest local coder is the
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

Checked 2026-09-29.

- Anthropic, Choosing the right model: https://platform.claude.com/docs/en/about-claude/models/choosing-a-model
- Anthropic, Models overview (prices, defaults): https://platform.claude.com/docs/en/models/overview
- Anthropic, Effort: https://platform.claude.com/docs/en/build-with-claude/effort
- Anthropic, Optimizing for cost and intelligence: https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence
- Anthropic, How we built our multi-agent research system: https://www.anthropic.com/engineering/multi-agent-research-system
- OpenAI, Model selection: https://developers.openai.com/api/docs/guides/model-selection
- OpenAI, Reasoning (effort table): https://developers.openai.com/api/docs/guides/reasoning
- OpenAI, Using GPT-6: https://developers.openai.com/api/docs/guides/latest-model
- Google, Gemini thinking: https://ai.google.dev/gemini-api/docs/thinking
