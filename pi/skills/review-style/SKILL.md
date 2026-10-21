---
name: review-style
description: Review code or plans the way Max does. Use whenever you review a diff, commit, branch, pull request or plan for Max, or draft review comments on his behalf (GitHub, tuicr, crit). Covers comment format and tone, verdicts, change hygiene, what to hunt for, design and type feedback, comments, tests and plan reviews.
---

# Review style

Distilled from Max's reviews of pull requests, plus tuicr and crit reviews of agent work.
For Rust code, also apply the `rust-style` skill: every rule there is a review finding when violated.

## Comment format

- Start every inline comment with a severity marker:
  - 🔴 must fix: bugs, data loss, races, security or privacy holes, broken invariants, panics in service code, commented-out code, violations of an explicit repo rule.
  - 🟠 should fix: a real concern or a clearly better approach. Usually phrased as a question.
  - 🟢 optional: nitpicks, taste, ideas for later. Say so: "nitpick", "feel free to ignore", "debatable whether this is better".
  - No marker for pure questions, information and replies.
  - When the level is surprising, say why: "Making this 🟠 not 🟢 because …".
- Prefer a `suggestion` block with complete replacement code over describing the change. For deep nesting, suggest the whole de-nested rewrite.
- Ask instead of ordering when intent is unclear: "Why …?", "Shouldn't this …?", "Is this still needed?", "Maybe a stupid question, but …".
- Explain the mechanism, not only the rule. Not "don't use protobuf as a key" but "protobuf doesn't guarantee the same bytes for the same value, so it can't be a partition key".
- Point to precedent: permalinks into the repo (commit SHA, line range), library docs, the relevant repo skill.
- When several fixes are acceptable, list them: "There are 3 options I would be fine with: 1. … 2. … 3. …".
- Hedge real uncertainty ("not 100% sure", "worth double-checking"). When a comment turns out wrong, retract plainly: "Nevermind, I missed X."
- Comment once for a repeated pattern: "Only commenting once, but this applies to all `Box::pin` in this PR." Use "Same here" for follow-ups.
- Be warm where it's earned: thank people for taking on unpleasant work, call out things you like ("Liking that helper method!") or learned.

## Verdict and scope

- Default to approve with comments: "Feel free to merge as-is, but if you have time …", "LGTM once X is addressed".
- Request changes only for real hazards: a mutex guard held across `.await`, a regression on deploy, a privacy oracle, reintroducing something deliberately removed.
- Put the one big open question at the top of the review body ("The biggest open question is …").
- State what you did and didn't review: "Only looked at the notifications part", "Not done yet, submitting what I have", "don't treat this as a comprehensive review". Suggest another reviewer for areas outside your depth.
- On a first pass of a big change, it's fine to split: style now, approach in the next round. Say so.

## Change hygiene

- One thing at a time. A port or extraction must not also change behaviour: "Let's take this as closely as possible from what X does." Behaviour changes and redesigns go into separate changes or discussions.
- Prefer shipping a minimal version and iterating over growing the change.
- Flag unrelated or accidental changes, including reformatting and touched tests.
- Flag leftovers: local IPs or URLs, commented-out code, empty `TODO`s, debug logs at `info`, workarounds that are no longer needed.
- For agent-written commits: one logical change per commit, fixes as fixups to the right commit, commit messages that match reality.
- Local working notes (exploration notes, RFC drafts) may be committed locally but never go upstream: they belong in their own commit so they can be dropped before pushing. Flag them when they're mixed into a code commit, and flag code, comments or docs that reference them.

## What to hunt for

### Concurrency

- Lock guards held across `.await`; locks held longer than needed.
- Atomic orderings that don't create the needed happens-before (`Relaxed` where `Acquire`/`Release` is required).
- `tokio::select!` assumed to poll in order (it's random unless `biased;`). Prefer `CancellationToken::run_until_cancelled` over a `select!` on cancellation.
- Tasks aborted while they may be mid-write; cancel cooperatively and let them finish.
- Loops that spin forever on a closed channel (`loop { if let Some(x) = rx.recv().await … }`).
- Unbounded `spawn` per request or per event: use a queue with a worker and bounded concurrency, monitor its length, flush on shutdown.
- One slow consumer blocking all others (shared queues, broadcast channels dropping with `Lagged`).
- Sequential awaits that could run concurrently, when it matters.

### Idempotency and races

- Client-controlled ids used as idempotency or workflow keys need a server-verified qualifier such as the user id.
- Check-then-write sequences outside a serialized context.
- Replays after a crash between two writes; dedup that relies on an idempotency cache with a shorter TTL than the gap between triggers.

### Wire and storage compatibility

- Any type that gains `Serialize`/`Deserialize` or crosses a process boundary needs regression tests against hard-coded JSON (minimal and full payloads), not round-trips.
- New fields must still deserialize from old payloads; old fields must keep their names.
- Protobuf: field numbers are the contract, names aren't; never use protobuf bytes as database or partition keys.
- Bytes in JSON go through a string encoding (base64, `Display`), never as an array of numbers. Ids use a compact string form, not the derived serialization of their internals.
- Top-level responses should be JSON objects so fields can be added later.
- Database schema changes ship with the code that uses them; check primary keys express the intended cardinality.

### Errors and failure modes

- Every network client needs a timeout (reqwest has none by default) and `error_for_status`.
- Match the specific error you mean (both a gRPC `NotFound` and an HTTP 404), not "any error".
- No panics in service code. Use permanent or terminal errors where retrying can't help, for example a removed handler.
- No silent truncation: a bounded read that drops results without any signal is a bug.
- No in-band signalling (`0` meaning "no limit"): use `Option` or `NonZero*`.
- Logs: per-request logs at `debug`, not `info`. Errors either propagate or get logged once. Rate-limit logs that can fire extremely rapidly (per message, per dropped item).

### Security, privacy and production safety

- Lookups need an authorization check; ask whether the endpoint could be used as an oracle (for example "do these two users have a DM?").
- Secrets or personal endpoints committed in code.
- CLI tools default to local, never production; production needs an explicit flag.
- Gradual rollouts use a percentage on a stable hash of the full id, not bits of a timestamp or a modulo that only allows 50%, 33%, 25%.
- Rollout knobs live in config with a safe default, not in a `const`.

### Performance, with judgement

- Unnecessary clones, collect-then-iterate, re-collecting into the same collection, copying an owned `Cow`.
- Queries that fetch far more rows than the caller needs.
- Regexes compiled per call; `block_in_place` on the async runtime; CPU work on runtime threads.
- Note when something is inefficient but fine for now: "can be optimized if it becomes a problem".

## Design and types

- Make invalid states unrepresentable:
  - an enum instead of a boolean parameter that's unreadable at the call site;
  - `Option` instead of a hand-rolled `Some`/`None` enum;
  - `Option<Vec<_>>` instead of a `Vec` plus a "loaded" flag;
  - `NonZero*` instead of runtime `> 0` checks;
  - don't store a value that can be derived from other stored values, especially in persisted state (for example a cursor holding both `next_page_index` and `current_page_id` when the current page is `pages[next_page_index - 1]`); derive it at runtime so the two can't disagree;
  - pass the lock guard as a parameter as proof the caller holds the lock;
  - exhaustive `match` so a new variant forces an update.
- Encode assumptions in code: if two calls must never overlap, enforce it (`try_lock` and panic) or at least document it.
- Real types over strings and integers: id newtypes instead of `String`, a duration type instead of raw milliseconds.
- Put logic where the knowledge is: a method on the type that knows the details, not inline at the caller. Thin wrappers stay thin. Storage layers store data; business logic lives above them. A store doesn't know about dry runs; the handler decides whether to paginate.
- Abstract the choice behind the interface: callers shouldn't know which implementation they got.
- Don't over-abstract: question traits with one implementation, wrappers that only forward, newtypes around an error type without variants, helper functions around a single metrics call, "a simple `if` would be sufficient", "overkill for something we run once".
- Reuse before hand-rolling: existing helpers and libraries, `backon` for retries, `try_ready_chunks`. Check whether a dependency already exists transitively.
- Smallest scope: constants and statics inside the function that uses them, no `pub` without a user outside the crate.
- Methods follow the step-down rule: callers above callees.

## Observability

- Keep monitoring out of the happy path: an observer type or a future wrapper instead of timing code inline. Don't add metrics that existing metrics already provide.
- Don't set a log `target` manually; the module path is the target. Log fields as `?field`.

## Comments and docs

- Remove comments that restate the code, justify the change to the reviewer, or are LLM filler. Be blunt: "Completely useless comment".
- Move comments to what they describe: field docs on the field, a decision inside the method it affects, a variant note on the variant.
- Keep hard-won comments when code moves: "This comment represents at least several hours of debugging effort."
- Ask for a comment where behaviour is non-obvious or an invariant is assumed.
- Replace separator comments (`// ------`) with functions or modules.
- Link the source of copied configuration and use permalinks for external specs.

## Tests

- Parsers, URL matchers and encodings need unit tests with real inputs: "Put in some URLs that you tested with!"
- Serde types need regression tests against hard-coded JSON; round-trip tests alone don't count.
- Tests use arrange/act/assert sections with the expected value not inlined into the assert.
- Inline `#[cfg(test)]` modules over separate test crates; exposing internals for a test crate is a smell.
- Deleting a test needs a replacement. For agent-written changes, ask to remove low-value tests.

## Plan reviews

- Hold the plan to the real goal: "The main point of this command is to find the broken ones, not fix one given id."
- Simplify: fewer roundtrips, drop verification or tests that don't pay off, reuse existing commands and formats, prefer plain formats such as CSV.
- Derive data from the source of truth instead of fetching it separately.
- Check resource use: stream large inputs, open a file once, keep at most one unit (a page) in memory.
- Insist on precision: label estimates as estimates and show the numbers behind them, prefer ordered processing over tracking a maximum.
- Mark out-of-scope sections that are actually in scope, and the reverse.
