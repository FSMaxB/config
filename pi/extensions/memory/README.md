# Project memory (work in progress)

**Not yet the full memory port.** This extension is opt-in and defaults off. It currently supports project-scoped manual claims, bounded literal search, context injection, and a basic opted-in extraction worker. It does **not** yet implement consolidation, immutable generation artifacts, manifest-backed `memory_read`, retention, source revisions, complete usage accounting, or the required lifecycle/multiprocess smoke matrix. Do not use it for privacy-critical memory until those pieces are complete.

## Configuration

Create `<agentDir>/memory.json` (`agentDir` is Pi's `getAgentDir()`, overrideable with `PI_CODING_AGENT_DIR`):

```json
{
  "enabled": false,
  "useMemories": true,
  "generateMemories": true,
  "extractionModel": "provider/model-id",
  "consolidationModel": "provider/model-id",
  "limits": {
    "maxJobsPerDay": 20,
    "maxInputEstimatedTokensPerDay": 200000,
    "maxOutputTokensPerDay": 40000
  }
}
```

The project root is the nearest ancestor containing `.jj` or `.git`, or canonical cwd otherwise. Project overrides live at `<agentDir>/memory-projects/<SHA-256-of-canonical-root>.json`. A trusted project must be explicitly activated with `/memory on` unless global `enabled` is true. **Activating means recent opted-in conversation excerpts may be uploaded to the configured extraction provider.** No model is silently selected. The consolidation model setting is currently checked but no consolidation requests are made.

`/memory status`, `/memory on`, `/memory off`, and `/memory reload` manage activation. Status includes the most recent extraction failure reason (a redacted, truncated error message) so a provider that answers with something other than the requested JSON can be diagnosed without the discarded payload. `/memory remember <text>`, `/memory correct <claim-id> <text>`, `/memory forget <claim-id>`, `/memory forget-source <source-id>`, and `/memory reset` modify the local SQLite store. Forget and reset require a confirmation-capable UI; they cannot erase previously sent provider input, Pi session history, native compaction, or existing answers. Search with `memory_search {"query":"literal text"}` or read a claim using `memory_read {"id":"claim-id"}` while memory is enabled. Inferred claims are not equivalent to explicit preferences.

The memory overview reaches the model as a hidden `memory-injection` custom message that Pi persists in the session, written before a prompt whenever the memory snapshot changed since the last one on the current branch. Persisting it keeps Pi's history and the provider's transcript identical; a message added only through the `context` hook is invisible to Pi, and the claude-bridge replayed such a trailing message as a mid-turn steer after every tool call. Earlier injections stay in the history as stale context, and evidence collection never reads custom messages, so injected text is not extracted again.

Storage is `<agentDir>/memory/<project-hash>/memory.sqlite`. The store is not opened while disabled except by explicit destructive commands after confirmation. Secret redaction is best-effort, **not** a guarantee: do not enable this extension for conversations containing sensitive data until the pipeline is fully audited. Read-only evidence checking does not mutate Pi's session JSONL. This extension must not be granted generic read/write access to its storage directory.

## Offline checks

Run `npm ci`, `npm test`, and `npm run typecheck` from this directory. Tests use temporary projects, fake lifecycle contexts and SQLite connections; they make no provider requests. Restart Pi to load changes to this directory extension. Do not run the repository's `install.sh` as a test.
