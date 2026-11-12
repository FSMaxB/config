import { spawn } from "node:child_process";
import type { SandboxViolationStore } from "@anthropic-ai/sandbox-runtime";
import { INITIAL_LOG_STREAM_STATE, parseLogStreamChunk } from "./log-stream.ts";
import type { PolicyOptions } from "./policy.ts";

export interface CollectedViolation {
  line: string;
}

// Keeps every violation of the commands being tracked. srt's own store is a 100-entry ring shared by all commands,
// and its macOS monitor keeps only the first violation of each `log stream` chunk.
export interface ViolationCollector {
  track(commandId: string): void;
  violationsFor(commandId: string): CollectedViolation[];
  release(commandId: string): void;
  stop(): void;
}

export function startViolationCollector(platform: PolicyOptions["platform"], store: SandboxViolationStore): ViolationCollector {
  const byCommand = new Map<string, CollectedViolation[]>();
  const record: RecordViolation = (encodedCommand, line) => {
    if (encodedCommand === undefined) return;
    byCommand.get(decodeCommandKey(encodedCommand))?.push({ line });
  };
  const stop = platform === "darwin" ? streamMacOSViolations(record) : followStore(store, record);
  return {
    track(commandId) { byCommand.set(commandId, []); },
    violationsFor(commandId) { return [...(byCommand.get(commandId) ?? [])]; },
    release(commandId) { byCommand.delete(commandId); },
    stop,
  };
}

type RecordViolation = (encodedCommand: string | undefined, line: string) => void;

// srt's tag suffix is private to its module, but every srt tag ends in `_SBX`. Violations of other srt users
// (another pi, Claude Code) match too and are dropped because their command keys are not tracked here.
function streamMacOSViolations(record: RecordViolation): () => void {
  const child = spawn("log", ["stream", "--predicate", 'eventMessage ENDSWITH "_SBX"', "--style", "compact"], { stdio: ["ignore", "pipe", "ignore"] });
  // Without a listener a missing `log` binary would crash pi; violations then simply stay empty, as before.
  child.on("error", () => undefined);
  child.stdout.setEncoding("utf8");
  let state = INITIAL_LOG_STREAM_STATE;
  child.stdout.on("data", (chunk: string) => {
    const parsed = parseLogStreamChunk(state, chunk);
    state = parsed.state;
    for (const { line, encodedCommand } of parsed.violations) record(encodedCommand, line);
  });
  return () => { child.kill("SIGTERM"); };
}

// The store notifies synchronously on every add, so the newest entries are the ones added since the last call.
// Counting through getTotalCount() keeps clear() (which also notifies) from being read as new violations.
function followStore(store: SandboxViolationStore, record: RecordViolation): () => void {
  let seen = store.getTotalCount();
  return store.subscribe((violations) => {
    const added = Math.min(store.getTotalCount() - seen, violations.length);
    seen = store.getTotalCount();
    for (const { encodedCommand, line } of violations.slice(violations.length - added)) record(encodedCommand, line);
  });
}

// srt's key is base64 of the first 100 characters of the commandId; ours are UUIDs, so nothing is truncated.
function decodeCommandKey(encodedCommand: string): string {
  return Buffer.from(encodedCommand, "base64").toString("utf8");
}
