import { spawn } from "node:child_process";
import type { SandboxViolationStore } from "@anthropic-ai/sandbox-runtime";
import { INITIAL_LOG_STREAM_STATE, parseLogStreamChunk, SRT_VIOLATIONS } from "./log-stream.ts";
import type { PolicyOptions } from "./policy.ts";

export function startViolationCollector(platform: PolicyOptions["platform"], store: SandboxViolationStore): ViolationCollector {
  const byCommand = new Map<string, CollectedViolation[]>();
  // adopted command id → the command ids that also receive its violations
  const adopters = new Map<string, Set<string>>();
  const record: RecordViolation = (encodedCommand, line) => {
    if (encodedCommand === undefined) return;
    const commandId = decodeCommandKey(encodedCommand);
    for (const owner of [commandId, ...(adopters.get(commandId) ?? [])]) byCommand.get(owner)?.push({ line });
  };
  const stop = startSources(platform, store, record);
  return {
    track(commandId, adoptedCommandIds = []) {
      byCommand.set(commandId, []);
      for (const adopted of adoptedCommandIds) {
        const holders = adopters.get(adopted) ?? new Set();
        holders.add(commandId);
        adopters.set(adopted, holders);
      }
    },
    violationsFor(commandId) { return [...(byCommand.get(commandId) ?? [])]; },
    release(commandId) {
      byCommand.delete(commandId);
      for (const [adopted, holders] of adopters) {
        holders.delete(commandId);
        if (holders.size === 0) adopters.delete(adopted);
      }
    },
    stop,
  };
}

// Keeps every violation of the commands being tracked. srt's own store is a 100-entry ring shared by all commands,
// and its macOS monitor keeps only the first violation of each `log stream` chunk.
// A long-lived child, such as a bazel server, keeps the tag of the command that started it. A command that adopts
// that command's id receives the child's violations too.
export interface ViolationCollector {
  track(commandId: string, adoptedCommandIds?: readonly string[]): void;
  violationsFor(commandId: string): CollectedViolation[];
  release(commandId: string): void;
  stop(): void;
}

export interface CollectedViolation {
  line: string;
}

function startSources(platform: PolicyOptions["platform"], store: SandboxViolationStore, record: RecordViolation): () => void {
  if (platform !== "darwin") return followStore(store, record);
  const stopStream = streamMacOSViolations(record);
  // srt's own macOS monitor also stores filesystem violations, which the stream above already delivers in full.
  const stopStore = followStore(store, (encodedCommand, line) => { if (isProxyViolation(line)) record(encodedCommand, line); });
  return () => { stopStream(); stopStore(); };
}

// srt's proxies record network denials only in its store.
export function isProxyViolation(line: string): boolean {
  return /^deny (network-outbound|http-request) /.test(line);
}

// srt's tag suffix is private to its module, but every srt tag ends in `_SBX`. Violations of other srt users
// (another pi, Claude Code) match too and are dropped because their command keys are not tracked here.
function streamMacOSViolations(record: RecordViolation): () => void {
  const child = spawn("log", ["stream", "--predicate", 'eventMessage ENDSWITH "_SBX"', "--style", "compact"], { stdio: ["ignore", "pipe", "ignore"] });
  // Without a listener a missing `log` binary would crash pi; violations then simply stay empty.
  child.on("error", () => undefined);
  child.stdout.setEncoding("utf8");
  let state = INITIAL_LOG_STREAM_STATE;
  child.stdout.on("data", (chunk: string) => {
    const parsed = parseLogStreamChunk(state, chunk, SRT_VIOLATIONS);
    state = parsed.state;
    for (const { line, tag } of parsed.entries) {
      if (!isSystemNoise(line)) record(tag, line);
    }
  });
  return () => { child.kill("SIGTERM"); };
}

// Denials that macOS processes hit on their own, whatever the command does, and that do not change its outcome.
// srt's own monitor drops the diagnosticd and analyticsd lookups as well, but this stream bypasses that monitor.
// vfs.disk-space is reported for every statfs() (git, jj, rg, df), yet the call still returns the real values,
// because srt's profile has no rule for the system-info operation.
export function isSystemNoise(line: string): boolean {
  return SYSTEM_NOISE.test(line);
}

const SYSTEM_NOISE = /\sdeny\(\d+\)\s+(?:sysctl-read kern\.iossupportversion|mach-lookup com\.apple\.(?:diagnosticd|analyticsd)|system-info vfs\.disk-space)$/;

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

type RecordViolation = (encodedCommand: string | undefined, line: string) => void;

// srt's key is base64 of the first 100 characters of the commandId; ours are UUIDs, so nothing is truncated.
function decodeCommandKey(encodedCommand: string): string {
  return Buffer.from(encodedCommand, "base64").toString("utf8");
}
