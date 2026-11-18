import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import type { FilesystemConfig } from "@anthropic-ai/sandbox-runtime";
import type { BashOperations, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { shellQuote } from "../../lib/panes.ts";
import { waitUntilCountSettles } from "./settle.ts";
import type { PathSelector } from "../../lib/path-permission-rules.ts";
import { normalizePathSelector } from "../../lib/path-permissions.ts";
import type { EffectivePolicy } from "../../lib/path-permissions.ts";
import { INITIAL_LOG_STREAM_STATE, parseLogStreamChunk } from "./log-stream.ts";
import type { LogStreamFormat } from "./log-stream.ts";
import { addFilesystemEntry, emptyProfileDefinition, isValidProfileName } from "./profiles.ts";
import type { Profile } from "./profiles.ts";
import { buildDraft, draftText, parseDraftText, traceAccesses } from "./recording.ts";
import { loadProfiles, updateProfile } from "./settings.ts";
import { traceProfile } from "./trace-profile.ts";

export interface RecorderDependencies {
  settingsFile: string;
  homeDirectory: string;
  ensureInitialized(): Promise<void>;
  stockExec: BashOperations["exec"];
  // The filesystem the normal sandbox would apply to a bash call with these profiles, minus the generated VCS globs.
  traceFilesystem(profiles: readonly Profile[]): Promise<FilesystemConfig>;
  // The policy without profile grants, so the draft contains only what the profile still needs.
  baselinePolicy(): Promise<EffectivePolicy>;
  toolchainRead(): readonly string[];
  secretPaths(): string[];
  repositoryRoot(): Promise<string>;
  profileEnvironment(base: NodeJS.ProcessEnv, profiles: readonly Profile[]): Promise<NodeJS.ProcessEnv>;
}

export interface Recorder {
  arm(name: string, context: ExtensionCommandContext): Promise<void>;
  stop(context: ExtensionCommandContext): Promise<void>;
  // Records a `!` command and returns the tracing operations to run it with, or undefined while no recording is armed.
  operationsFor(command: string): BashOperations | undefined;
  shutdown(): void;
}

interface Recording {
  profile: string;
  tag: string;
  commands: string[];
  lines: string[];
  stopStream: () => void;
  // The editor text of a review that failed validation, so the user's edits are not lost.
  reviewText: string | undefined;
}

// `log stream` prints its header within a second; a slow start must not block arming forever.
const STREAM_HEADER_TIMEOUT_MILLISECONDS = 3000;

export function createRecorder(dependencies: RecorderDependencies): Recorder {
  let recording: Recording | undefined;

  return {
    arm,
    stop,
    operationsFor(command) {
      if (!recording) return undefined;
      recording.commands.push(command);
      return { exec: execTraced };
    },
    shutdown() {
      recording?.stopStream();
      recording = undefined;
    },
  };

  async function arm(name: string, context: ExtensionCommandContext): Promise<void> {
    if (process.platform !== "darwin") {
      context.ui.notify("Recording needs macOS.", "error");
      return;
    }
    if (recording) {
      context.ui.notify(`Already recording profile ${recording.profile}; finish it with /sandbox-profile stop.`, "error");
      return;
    }
    if (!isValidProfileName(name)) {
      context.ui.notify(`"${name}" is not a valid profile name.`, "error");
      return;
    }
    let created = false;
    await updateProfile(dependencies.settingsFile, name, (current) => {
      created = current === undefined;
      return current ?? emptyProfileDefinition();
    });
    const tag = `PIREC_${randomUUID().replaceAll("-", "")}_END`;
    const lines: string[] = [];
    const stopStream = await streamAllowedAccesses(tag, (line) => lines.push(line));
    recording = { profile: name, tag, commands: [], lines, stopStream, reviewText: undefined };
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- updateProfile sets created from its update callback
    const extension = created ? ` Set its triggers and PATH with /sandbox-profile edit ${name}.` : "";
    context.ui.notify(
      `Recording profile ${name}. Run the commands with ! or !! (they run outside the sandbox, traced). For bazel, start with !bazel shutdown so the server runs traced. Finish with /sandbox-profile stop.${extension}`,
      "info",
    );
  }

  async function execTraced(command: string, cwd: string, options: ExecOptions): Promise<ExecResult> {
    const active = recording;
    if (!active) throw new Error("No recording is armed.");
    await dependencies.ensureInitialized();
    const profiles = (await loadProfiles(dependencies.settingsFile)).filter(({ name }) => name === active.profile);
    const filesystem = await dependencies.traceFilesystem(profiles);
    const environment = await dependencies.profileEnvironment(options.env ?? process.env, profiles);
    // A fingerprint of its own makes the bazel shim restart a server that runs with another profile.
    const tracedEnvironment = { ...environment, PI_SANDBOX_PROFILE_FINGERPRINT: `recording-${active.tag}`, PI_SANDBOX_RECORDING: "1" };
    const wrapped = `/usr/bin/sandbox-exec -p ${shellQuote(traceProfile(filesystem, active.tag))} /bin/bash -c ${shellQuote(command)}`;
    return await dependencies.stockExec(wrapped, cwd, { ...options, env: tracedEnvironment });
  }

  async function stop(context: ExtensionCommandContext): Promise<void> {
    const active = recording;
    if (!active) {
      context.ui.notify("Not recording. Start with /sandbox-profile record <name>.", "error");
      return;
    }
    await waitUntilCountSettles(() => active.lines.length);
    const text = active.reviewText ?? (await draftFor(active));
    const edited = await context.ui.editor(`Recording for profile ${active.profile}`, text);
    if (edited === undefined) {
      context.ui.notify("Still recording; run /sandbox-profile stop to review again.", "info");
      return;
    }
    if (edited.trim() === "") {
      finish(active);
      context.ui.notify("Recording discarded.", "info");
      return;
    }
    const { entries, errors } = parseDraftText(edited);
    if (errors.length > 0) {
      active.reviewText = edited;
      context.ui.notify(`The recording was not saved:\n${errors.join("\n")}\nRun /sandbox-profile stop to fix it.`, "error");
      return;
    }
    await updateProfile(dependencies.settingsFile, active.profile, (current) => {
      let definition = current ?? emptyProfileDefinition();
      for (const { mode, entry } of entries) definition = addFilesystemEntry(definition, mode, entry);
      return definition;
    });
    finish(active);
    context.ui.notify(`Saved ${entries.length} entries to profile ${active.profile}. The next sandboxed bazel call restarts a server the sandbox started.`, "info");
  }

  function finish(active: Recording): void {
    active.stopStream();
    if (recording === active) recording = undefined;
  }

  async function draftFor(active: Recording): Promise<string> {
    const accesses = traceAccesses(active.lines);
    const directories = new Set<string>();
    for (const { path } of accesses) if ((await stat(path).catch(() => undefined))?.isDirectory()) directories.add(path);
    const profile = (await loadProfiles(dependencies.settingsFile)).find(({ name }) => name === active.profile);
    const draft = buildDraft({
      accesses,
      directories,
      policy: await dependencies.baselinePolicy(),
      toolchainRead: dependencies.toolchainRead(),
      existing: { read: await selectors(profile?.filesystem.read ?? []), write: await selectors(profile?.filesystem.write ?? []) },
      secrets: dependencies.secretPaths(),
      repositoryRoot: await dependencies.repositoryRoot(),
      homeDirectory: dependencies.homeDirectory,
    });
    return draftText(draft, { profile: active.profile, commands: active.commands, accessCount: accesses.length }, dependencies.homeDirectory);
  }

  async function selectors(entries: readonly string[]): Promise<PathSelector[]> {
    return await Promise.all(entries.map((entry) => normalizePathSelector(entry, dependencies.homeDirectory)));
  }
}

const ALLOWED_ACCESS: LogStreamFormat = { action: "allow", tag: /^(PIREC_\w+_END)/ };

// Resolves once `log stream` printed its first output, so accesses right after arming are not lost.
function streamAllowedAccesses(tag: string, onLine: (line: string) => void): Promise<() => void> {
  const child = spawn("log", ["stream", "--predicate", `eventMessage CONTAINS "${tag}"`, "--style", "compact"], { stdio: ["ignore", "pipe", "ignore"] });
  child.on("error", () => undefined);
  child.stdout.setEncoding("utf8");
  let state = INITIAL_LOG_STREAM_STATE;
  return new Promise((resolve) => {
    const stop = () => { child.kill("SIGTERM"); };
    const timer = setTimeout(() => resolve(stop), STREAM_HEADER_TIMEOUT_MILLISECONDS);
    child.stdout.on("data", (chunk: string) => {
      clearTimeout(timer);
      const parsed = parseLogStreamChunk(state, chunk, ALLOWED_ACCESS);
      state = parsed.state;
      for (const { line } of parsed.entries) onLine(line);
      resolve(stop);
    });
  });
}

type ExecOptions = Parameters<BashOperations["exec"]>[2];
type ExecResult = Awaited<ReturnType<BashOperations["exec"]>>;
