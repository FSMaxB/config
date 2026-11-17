import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createBashToolDefinition, createLocalBashOperations, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { BashOperations, BashSpawnContext, BashToolDetails, ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { currentAgentMode, currentPolicy, grantPathAccess, type OnceGrant } from "../../lib/path-permissions.ts";
import { profileDestinations } from "../../lib/permission-choices.ts";
import { ALL_DURATIONS, askPermission, Duration, type PermissionAnswer } from "../../lib/permission-prompt.ts";
import { permissionUI } from "../../lib/permission-ui.ts";
import { registerToolWithGuidelines } from "../../lib/register-tool.ts";
import { findRepoRoot, resolveThroughSymlinks } from "../../lib/repo.ts";
import { markSandboxActive } from "../../lib/sandbox-state.ts";
import { latestCustomData } from "../../lib/session-entries.ts";
import { announceSessionGrantsChanged, provideSessionGrants, type SessionGrant } from "../../lib/session-grants.ts";
import { serialize } from "../../lib/ui-queue.ts";
import { BYPASS_DURATIONS, bypassOutcome, bypassPrompt, bypassSessionGrants, resolveAnswer, type BypassAuthorization, type SessionDecision } from "./bypass.ts";
import { credentialEnvVars } from "./credentials.ts";
import { NETWORK_ENTRY_TYPE, NO_PROFILE_NETWORK, destinationKey, emptyGrants, networkConfig, networkDenialNote, parseGrants, recordGrant, recordOnceGrant, releaseOnceGrants, rememberedDecision, networkSessionGrants, serializeGrants, type NetworkDecision, type NetworkGrants, type OnceNetworkGrants } from "./network-grants.ts";
import { activationOutcome, activationPrompt, emptyProfileState, parseProfileState, PROFILE_ENTRY_TYPE, profileSessionGrants, resolveActivationAnswer, serializeProfileState, settledResolution, type ActivationOrigin, type ActivationResolution, type RecordedDecision, type ProfileSessionState } from "./profile-activation.ts";
import { parseProfileCommand, profileCompletions, profileListText, type ProfileCommand } from "./profile-command.ts";
import { profileEnvironment, withoutRepositoryWrites, stateDirectoryIn, type ProfileInputs } from "./profile-grants.ts";
import { profileGrants } from "./profile-policy.ts";
import { matchTrigger } from "./profile-triggers.ts";
import { filesystemConfig, secretPaths, type PolicyOptions } from "./policy.ts";
import { addAllowedDomain, addFilesystemEntry, emptyProfileDefinition, mergedProfileNetwork, parseProfileDefinition, recordActivationDecision, selectorText, type NetworkAllowances, type Profile } from "./profiles.ts";
import { createRecorder } from "./recorder.ts";
import { exportSessionScratch, withSessionScratch } from "./scratch.ts";
import { loadActivationDecisions, loadProfiles, loadSettings, updateActivationDecisions, updateDomainLists, updateProfile, type Settings } from "./settings.ts";
import { resolveSandboxShell } from "./shell.ts";
import { scanVcsLayout, vcsWriteRules, type VcsWriteRules } from "./vcs-policy.ts";
import { isHereDocumentTemporaryFile, isRepositoryRootRemoval, isSecretPath, pathViolations, type PathViolation } from "./violations.ts";
import { startViolationCollector, type ViolationCollector } from "./violation-collector.ts";
import { CommandExit, discardedWriteReport, HERE_DOCUMENT_REPORT, networkDenialReport, nextStep, promptDurations, rawViolationBlock, violationReport, type NextStep, type ViolationOutcome } from "./violation-outcomes.ts";

const SANDBOX_NOTE =
  "Commands run inside an OS sandbox that enforces the same read/write path rules as the file tools, with no network except allowed hosts. Denied paths are reported in a <sandbox_violations> block and the user is asked to grant them; after a grant the command has to be rerun, unless the user allowed it once: then the sandbox reruns it itself and the rerun's output follows the report. Never try to work around a denial. Sandbox profiles (extra permissions the user approved for tools such as bazel) apply to a single bash call: one whose command matches a profile's triggers, or one that names the profile in profiles (for commands the triggers miss, such as wrapper scripts). The user confirms a profile unless they already allowed it, and a refused requested profile fails the call; do not retry it with that profile. " +
  "Set unsandboxed to true only for a command the sandbox itself breaks (ssh git remotes, programs that ignore proxy variables, listening sockets); the user confirms every unsandboxed command first, and subagents cannot use it.";

const SCRATCH_GUIDELINE =
  "For scratch files use mktemp (or a path under $TMPDIR), never a fixed /tmp/<name> path: /tmp is not writable in the sandbox and is shared between sessions. $TMPDIR is a per-session directory the file tools can read and write without prompting.";

const INSTALL_HINT =
  "Install with: sudo pacman -S bubblewrap socat ripgrep (Arch) or apt install bubblewrap socat ripgrep (Debian/Ubuntu, plus sysctl kernel.apparmor_restrict_unprivileged_userns=0 and apparmor_parser -R /etc/apparmor.d/bwrap-userns-restrict). Set PI_SANDBOX=0 to run without the sandbox.";

// macOS reports violations asynchronously through `log stream`, so they land a moment after the child
// exits, sometimes later than any single fixed wait. Keep polling until the count stops changing.
const VIOLATION_POLL_MILLISECONDS = 250;
const VIOLATION_MAX_POLLS = 6;
// Per command, across all reruns of that command.
const MAX_PATH_PROMPTS_PER_COMMAND = 5;

const CONFIG_ID_WARNING =
  "Sandbox: this jj repo has no config-id, so on Linux the sandbox cannot stop a planted .jj/repo/config.toml or .jj/workspace-config.toml. Run `jj config path --repo` and `jj config path --workspace` once to create the ids.";

const OLD_BASH_WARNING =
  "Sandbox: no bash 5.1 or newer found, so sandboxed commands run with the system bash, whose here-documents fail when the current directory is not writable. Install one (macOS: `brew install bash`) and restart pi.";

// Commands whose tags a later profiled command adopts, so violations of the long-lived servers they started stay visible.
const MAX_ADOPTED_COMMANDS = 200;

const SANDBOX_TEMPORARY_DIRECTORY = "/tmp/claude";
const SETTINGS_FILE = join(getAgentDir(), "sandbox.json");

interface ProfilesForCall {
  names: string[];
  // Why a triggered profile was not activated; shown to the agent before the command's output.
  notices: string[];
}

interface Runtime {
  operationsFor(profileNames: readonly string[], notices: readonly string[]): BashOperations;
  profilesForCall(command: string, requested: readonly string[], context: ExtensionContext): Promise<ProfilesForCall>;
  runProfileCommand(command: ProfileCommand, context: ExtensionCommandContext): Promise<void>;
  profileNames(): Promise<string[]>;
  recordingOperations(command: string): BashOperations | undefined;
  setActiveContext(context: ExtensionContext): void;
  authorizeBypass(command: string, context: ExtensionContext): Promise<BypassAuthorization>;
  restoreGrants(sessionManager: { getEntries(): readonly unknown[] }): void;
  sessionGrants(): SessionGrant[];
  shutdown(): Promise<void>;
}

type SandboxManagerType = typeof import("@anthropic-ai/sandbox-runtime")["SandboxManager"];

export default function (pi: ExtensionAPI) {
  if (process.env.PI_SANDBOX === "0") return;
  const cwd = process.cwd();
  if (process.platform !== "darwin" && process.platform !== "linux") {
    registerToolWithGuidelines(pi, withSandboxNote(createBashToolDefinition(cwd, { operations: unsupportedOperations() })));
    return;
  }
  markSandboxActive();
  const runtime = createRuntime(pi);
  provideSessionGrants(pi.events, () => runtime.sessionGrants());
  pi.on("session_start", (_event, context) => runtime.restoreGrants(context.sessionManager));
  // srt's proxies and macOS log monitor keep the event loop alive, so without this a `pi -p`
  // subagent child that ran bash never exits.
  pi.on("session_shutdown", () => runtime.shutdown());
  registerToolWithGuidelines(pi, sandboxedBash(cwd, runtime));
  pi.registerCommand("sandbox-profile", {
    description: "List sandbox profiles, or record|stop|edit|forget|delete one",
    getArgumentCompletions: async (prefix) => profileCompletions(prefix, await runtime.profileNames().catch(() => [])),
    handler: async (args, context) => {
      const command = parseProfileCommand(args);
      if (command.kind === "error") return context.ui.notify(command.message, "error");
      await runtime.runProfileCommand(command, context);
    },
  });
  // The user's own `!` commands are traced, not sandboxed, while a recording is armed.
  pi.on("user_bash", (event) => {
    const operations = runtime.recordingOperations(event.command);
    return operations ? { operations } : undefined;
  });
}

function sandboxedBash(cwd: string, runtime: Runtime) {
  const spawnHook = (context: BashSpawnContext) => withSessionScratch(context, process.platform);
  const sandboxed = createBashToolDefinition(cwd, { operations: runtime.operationsFor([], []), spawnHook });
  const unsandboxed = createBashToolDefinition(cwd, { spawnHook });
  const parameters = Type.Object({
    ...sandboxed.parameters.properties,
    unsandboxed: Type.Optional(Type.Boolean({ description: "Run outside the sandbox after the user confirms; only for a command the sandbox itself breaks" })),
    profiles: Type.Optional(Type.Array(Type.String(), { description: "Sandbox profiles to apply to this call, for commands their triggers miss (such as wrapper scripts); the user confirms each" })),
  });
  const definition: ToolDefinition<typeof parameters, BashToolDetails | undefined, BashRenderState> = {
    ...withSandboxNote(sandboxed),
    promptGuidelines: [...(sandboxed.promptGuidelines ?? []), SCRATCH_GUIDELINE],
    parameters,
    async execute(toolCallId, params, signal, onUpdate, context) {
      const requested = params.profiles ?? [];
      if (params.unsandboxed === true) {
        if (requested.length > 0) throw new Error("Profiles only apply to sandboxed commands; drop either profiles or unsandboxed.");
        const authorization = await runtime.authorizeBypass(params.command, context);
        if (authorization.kind === "refuse") throw new Error(authorization.reason);
        return await unsandboxed.execute(toolCallId, params, signal, onUpdate, context);
      }
      runtime.setActiveContext(context);
      const { names, notices } = await runtime.profilesForCall(params.command, requested, context);
      // One definition per call, so parallel calls cannot race on which profiles apply.
      const definition = createBashToolDefinition(cwd, { operations: runtime.operationsFor(names, notices), spawnHook });
      return await definition.execute(toolCallId, params, signal, onUpdate, context);
    },
    renderCall(args, theme, context) {
      const component = sandboxed.renderCall?.(args, theme, context) ?? new Text("", 0, 0);
      if (args.unsandboxed === true && component instanceof Text) {
        component.setText(theme.fg("warning", theme.bold("unsandboxed $ ")) + theme.fg("toolTitle", theme.bold(args.command)));
      }
      return component;
    },
  };
  return definition;
}

type BashRenderState = ReturnType<typeof createBashToolDefinition> extends ToolDefinition<any, any, infer State> ? State : never;

function withSandboxNote<Definition extends ToolDefinition<any, any, any>>(definition: Definition): Definition {
  return { ...definition, description: `${definition.description}\n\n${SANDBOX_NOTE}` };
}

function unsupportedOperations(): BashOperations {
  return {
    async exec() {
      throw new Error(`Sandboxed bash is unavailable on ${process.platform}. Set PI_SANDBOX=0 to run without the sandbox.`);
    },
  };
}

function createRuntime(pi: ExtensionAPI): Runtime {
  const stock = createLocalBashOperations();
  const subagent = Boolean(process.env.PI_SUBAGENT_CHILD);
  // pi passes the same session-scoped ExtensionContext to every tool call, so parallel bash
  // calls racing this assignment all land on the same object; prompts are serialized via
  // serialize() in ui-queue.ts regardless.
  let activeContext: ExtensionContext | undefined;
  let initialization: Promise<void> | undefined;
  let settings: Settings | undefined;
  // Imported in initialize(), not at module level: sandbox-runtime (with node-forge) cost every pi
  // startup ~40 ms although only a bash command needs it.
  let sandboxManager: SandboxManagerType | undefined;
  let grants: NetworkGrants = emptyGrants();
  let profileNetwork: NetworkAllowances = NO_PROFILE_NETWORK;
  // Deliberately not persisted in the session: a resumed session asks again before bypassing the sandbox.
  let bypassDecision: SessionDecision | undefined;
  let warnedAboutConfigIds = false;
  // Undefined makes srt look up `bash` on PATH itself.
  let shell: string | undefined;
  let collector: ViolationCollector | undefined;
  const onceNetworkGrants: OnceNetworkGrants = new Map();
  // One id per bash call, shared by its reruns: once-answers to network prompts are scoped to these.
  const runningExecutions = new Set<number>();
  let nextExecution = 0;
  // One id per pi process, i.e. per lifetime of srt's proxy: a bazel server started by an earlier pi keeps that pi's proxy.
  const instance = randomUUID();
  let profileState: ProfileSessionState = emptyProfileState();
  // execution id → the profiles that call runs with
  const runningProfiles = new Map<number, string[]>();
  // srt command ids of profiled runs, newest last
  const profiledCommandIds: string[] = [];
  const recorder = createRecorder({
    settingsFile: SETTINGS_FILE,
    homeDirectory: homedir(),
    ensureInitialized,
    stockExec: (command, cwd, options) => stock.exec(command, cwd, options),
    async traceFilesystem(profiles) {
      const inputs = await profileInputs();
      const profileOnceGrants = withoutRepositoryWrites(await profileGrants(profiles, inputs), inputs.repositoryRoot, inputs.agentMode);
      return filesystemConfig(await currentPolicy(profileOnceGrants), policyOptions(undefined));
    },
    baselinePolicy: () => currentPolicy(),
    toolchainRead: () => settings?.toolchainRead ?? [],
    secretPaths: () => secretPaths(homedir()),
    repositoryRoot: async () => await resolveThroughSymlinks(findRepoRoot()),
    async profileEnvironment(base, profiles) { return profileEnvironment(base, profiles, await profileInputs()); },
  });

  return {
    operationsFor,
    profilesForCall,
    runProfileCommand,
    profileNames: async () => (await loadProfiles(SETTINGS_FILE)).map(({ name }) => name),
    recordingOperations: (command) => recorder.operationsFor(command),
    setActiveContext(context) { activeContext = context; },
    authorizeBypass,
    sessionGrants: () => [...networkSessionGrants(grants), ...profileSessionGrants(profileState), ...bypassSessionGrants(bypassDecision)],
    restoreGrants(sessionManager) {
      grants = parseGrants(latestCustomData(sessionManager, NETWORK_ENTRY_TYPE));
      profileState = parseProfileState(latestCustomData(sessionManager, PROFILE_ENTRY_TYPE));
      applyNetwork();
      // An invalid sandbox.json surfaces on the next bash call, which fails with its message.
      void refreshNetwork().catch(() => undefined);
      announceSessionGrantsChanged(pi.events);
    },
    async shutdown() {
      recorder.shutdown();
      const pending = initialization;
      initialization = undefined;
      if (!pending) return;
      // A failed initialization can still have started proxies or the log monitor.
      await pending.catch(() => undefined);
      collector?.stop();
      collector = undefined;
      await sandboxManager?.reset();
    },
  };

  function operationsFor(profileNames: readonly string[], notices: readonly string[]): BashOperations {
    return {
      async exec(command, cwd, options) {
        await ensureInitialized();
        if (notices.length > 0) options.onData(Buffer.from(notices.map((line) => `${line}\n`).join("")));
        const execution = nextExecution++;
        runningExecutions.add(execution);
        runningProfiles.set(execution, [...profileNames]);
        try {
          await refreshNetwork();
          return await runSandboxed(command, cwd, options, [], MAX_PATH_PROMPTS_PER_COMMAND, profileNames);
        } finally {
          runningExecutions.delete(execution);
          runningProfiles.delete(execution);
          releaseOnceGrants(onceNetworkGrants, execution);
          await refreshNetwork().catch(() => undefined);
        }
      },
    };
  }

  // Once-grants live only in this recursion, so they never outlast the command they were given for.
  // The prompt budget is per command too: each rerun draws from what the previous runs left.
  async function runSandboxed(command: string, cwd: string, options: ExecOptions, onceGrants: OnceGrant[], promptsLeft: number, profileNames: readonly string[]): Promise<ExecResult> {
    const { result, step, promptsUsed } = await runOnce(command, cwd, options, onceGrants, promptsLeft, profileNames);
    if (step.kind === "return" || options.signal?.aborted) return result;
    return await runSandboxed(command, cwd, options, [...onceGrants, ...step.grants], promptsLeft - promptsUsed, profileNames);
  }

  async function runOnce(command: string, cwd: string, options: ExecOptions, onceGrants: OnceGrant[], promptsLeft: number, profileNames: readonly string[]): Promise<{ result: ExecResult; step: NextStep; promptsUsed: number }> {
    const commandId = randomUUID();
    // Reloaded on every run, so an "Add to profile" answer applies to the rerun and changes the fingerprint the shim sees.
    const profiles = (await loadProfiles(SETTINGS_FILE)).filter(({ name }) => profileNames.includes(name));
    const inputs = await profileInputs();
    // Only profile grants are filtered: a once grant is the user's explicit answer to a prompt.
    const profileOnceGrants = withoutRepositoryWrites(await profileGrants(profiles, inputs), inputs.repositoryRoot, inputs.agentMode);
    violationCollector().track(commandId, profiles.length === 0 ? [] : profiledCommandIds);
    if (profiles.length > 0) rememberProfiledCommand(commandId);
    const vcs = await vcsRules();
    const filesystem = filesystemConfig(await currentPolicy([...profileOnceGrants, ...onceGrants]), policyOptions(vcs));
    warnAboutMissingConfigIds(vcs, filesystem.denyWrite);
    const environment = profiles.length === 0 ? options.env : profileEnvironment(options.env ?? process.env, profiles, inputs);
    try {
      const wrapped = await manager().wrapWithSandbox(exportSessionScratch(command, environment), shell, { filesystem }, options.signal, { commandId, commandText: command });
      const result = await stock.exec(wrapped, cwd, { ...options, env: environment });
      const exit = result.exitCode === 0 ? CommandExit.Succeeded : CommandExit.Failed;
      // Linux events arrive over the monitor socket and are best-effort after exit, so a successful command
      // pays one poll there; macOS reports asynchronously via `log stream`, so it polls until the count settles.
      const collected = exit === CommandExit.Succeeded && process.platform === "linux"
        ? await readViolationsAfterOneWait(commandId)
        : await collectViolations(commandId);
      const relevant = reportable(collected, vcs.repositoryRoot);
      const violations = relevant.filter(({ line }) => !isHereDocumentTemporaryFile(line));
      if (violations.length < relevant.length) options.onData(Buffer.from(HERE_DOCUMENT_REPORT));
      if (violations.length === 0) return { result, step: { kind: "return" }, promptsUsed: 0 };
      const lines = violations.map(({ line }) => line);
      options.onData(Buffer.from(rawViolationBlock(lines)));
      const discarded = discardedWriteReport(pathViolations(lines), filesystem, process.platform as PolicyOptions["platform"]);
      if (discarded) options.onData(Buffer.from(discarded));
      const { outcomes, promptsUsed } = await resolveViolations(violations, promptsLeft, profileNames, promptDurations(exit));
      const step = nextStep(outcomes, exit);
      // A command that only hit network denials has no path outcomes to report.
      if (outcomes.length > 0) options.onData(Buffer.from(violationReport(outcomes, step, currentAgentMode(), exit)));
      const denials = networkDenialReport(lines, networkNote);
      if (denials) options.onData(Buffer.from(denials));
      return { result, step, promptsUsed };
    } finally {
      manager().cleanupAfterCommand();
      violationCollector().release(commandId);
    }
  }

  function ensureInitialized(): Promise<void> {
    initialization ??= initialize().catch((error) => {
      initialization = undefined;
      throw error;
    });
    return initialization;
  }

  async function initialize(): Promise<void> {
    ({ SandboxManager: sandboxManager } = await import("@anthropic-ai/sandbox-runtime"));
    settings = await loadSettings(SETTINGS_FILE);
    // srt points TMPDIR here and always allows writes to it, but leaves creating it to the embedder.
    await mkdir(SANDBOX_TEMPORARY_DIRECTORY, { recursive: true, mode: 0o700 });
    const { errors, warnings } = await manager().checkDependenciesAsync();
    // Without the seccomp filter a sandboxed process could open unix sockets to escape the network rules.
    const seccompMissing = process.platform === "linux" ? warnings.filter((warning) => /seccomp/i.test(warning)) : [];
    const problems = [...errors, ...seccompMissing];
    if (problems.length > 0) throw new Error(`Sandboxed bash is unavailable: ${problems.join("; ")}. ${INSTALL_HINT}`);
    const choice = await resolveSandboxShell(process.env.PATH);
    shell = choice.kind === "found" ? choice.path : undefined;
    if (choice.kind === "missing") activeContext?.ui.notify(`${OLD_BASH_WARNING} Checked: ${choice.checked.join(", ")}.`, "warning");
    await manager().initialize(
      {
        network: networkConfig(settings, grants, subagent, profileNetwork),
        filesystem: filesystemConfig(await currentPolicy(), policyOptions(await vcsRules())),
        credentials: { envVars: credentialEnvVars() },
        allowPty: false,
      },
      askNetwork,
      true,
    );
    collector = startViolationCollector(process.platform as PolicyOptions["platform"], manager().getSandboxViolationStore());
  }

  // Without vcs the repository stays a plain subtree allow, which the recorder wants: it traces without the generated VCS globs.
  function policyOptions(vcs: VcsWriteRules | undefined): PolicyOptions {
    if (!settings) throw new Error("Sandbox settings are not loaded.");
    return { platform: process.platform as PolicyOptions["platform"], homeDirectory: homedir(), toolchainRead: settings.toolchainRead, extraDenyRead: settings.extraDenyRead, vcs };
  }

  // Scanned per command: git and jj create and remove entries inside their directories all the time.
  async function vcsRules(): Promise<VcsWriteRules> {
    const layout = await scanVcsLayout(await resolveThroughSymlinks(findRepoRoot()));
    return vcsWriteRules(layout, process.platform as PolicyOptions["platform"]);
  }

  // Plan and explore mode keep the repository read-only without the VCS denies, so they stay silent.
  function warnAboutMissingConfigIds(vcs: VcsWriteRules, denyWrite: string[]): void {
    if (warnedAboutConfigIds || vcs.missingConfigIds.length === 0) return;
    if (!vcs.deny.some((path) => denyWrite.includes(path))) return;
    warnedAboutConfigIds = true;
    activeContext?.ui.notify(CONFIG_ID_WARNING, "warning");
  }

  function manager(): SandboxManagerType {
    if (!sandboxManager) throw new Error("Sandbox runtime is not loaded.");
    return sandboxManager;
  }

  function violationCollector(): ViolationCollector {
    if (!collector) throw new Error("Sandbox violation collector is not running.");
    return collector;
  }

  function applyNetwork(): void {
    if (!sandboxManager || !settings) return;
    const config = sandboxManager.getConfig();
    if (!config) return;
    sandboxManager.updateConfig({ ...config, network: { ...config.network, ...networkConfig(settings, grants, subagent, profileNetwork) } });
  }

  // srt reads local binding and sockets from its global config, so the profile network settings of every
  // profiled bash call running right now are merged into it.
  async function refreshNetwork(): Promise<void> {
    const names = new Set([...runningProfiles.values()].flat());
    profileNetwork = names.size === 0 ? NO_PROFILE_NETWORK : mergedProfileNetwork((await loadProfiles(SETTINGS_FILE)).filter(({ name }) => names.has(name)));
    applyNetwork();
  }

  // The success-path report is best effort on Linux, where events arrive over the monitor socket, so
  // it pays one poll interval instead of waiting for the count to settle like a failed command does.
  async function readViolationsAfterOneWait(commandId: string) {
    await new Promise((resolve) => setTimeout(resolve, VIOLATION_POLL_MILLISECONDS));
    return violationCollector().violationsFor(commandId);
  }

  async function collectViolations(commandId: string) {
    let previousCount = -1;
    for (let poll = 0; poll < VIOLATION_MAX_POLLS; poll += 1) {
      await new Promise((resolve) => setTimeout(resolve, VIOLATION_POLL_MILLISECONDS));
      const count = violationCollector().violationsFor(commandId).length;
      if (count === previousCount) break;
      previousCount = count;
    }
    return violationCollector().violationsFor(commandId);
  }

  async function authorizeBypass(command: string, context: ExtensionContext): Promise<BypassAuthorization> {
    const outcome = bypassOutcome({ agentMode: currentAgentMode(), subagent, hasUI: context.hasUI, sessionDecision: bypassDecision });
    if (outcome.kind !== "ask") return outcome;
    const answer = await serialize(() => askPermission(permissionUI(context.ui), {
      title: bypassPrompt(command),
      subject: "unsandboxed commands",
      scope: command,
      narrower: [],
      durations: BYPASS_DURATIONS,
      preselected: outcome.preselected,
    }));
    const { authorization, remember } = resolveAnswer(answer);
    if (remember) {
      bypassDecision = remember;
      announceSessionGrantsChanged(pi.events);
    }
    return authorization;
  }

  async function askNetwork({ host, port }: { host: string; port: number | undefined }): Promise<boolean> {
    const remembered = rememberedDecision(grants, onceNetworkGrants, host, port);
    if (remembered) return remembered === "allow";
    const context = activeContext;
    if (!context?.hasUI) return false;
    const destination = port === undefined ? host : destinationKey(host, port);
    return await serialize(async () => {
      // Every connection to an unknown host lands here; the first answer settles the ones queued behind it.
      const latest = rememberedDecision(grants, onceNetworkGrants, host, port);
      if (latest) return latest === "allow";
      const answer = await askPermission(permissionUI(context.ui), {
        title: `Sandbox: allow network access to ${destination}?\n\n  Allowing grants ${host} (all ports)`,
        subject: `network access to ${host}`,
        scope: host,
        narrower: port === undefined ? [] : [{ label: `network access to ${destination}`, scope: destination }],
        durations: ALL_DURATIONS,
        destinations: profileDestinations(offeredProfiles()),
      });
      return await applyNetworkAnswer(answer, host);
    });
  }

  async function applyNetworkAnswer(answer: PermissionAnswer<string, string>, host: string): Promise<boolean> {
    if (answer.decision === "allow-to") {
      await updateProfile(SETTINGS_FILE, answer.destination, (current) => current && addAllowedDomain(current, answer.scope));
      await refreshNetwork();
      return true;
    }
    if (answer.decision === "allow") {
      if (answer.duration === Duration.Once) {
        recordOnceGrant(onceNetworkGrants, "allow", answer.scope, runningExecutions, undefined);
        return true;
      }
      rememberNetwork("allow", answer.scope, undefined);
      if (answer.duration === Duration.Always) await persistNetwork("allow", answer.scope, undefined);
      return true;
    }
    if (answer.duration === Duration.Once) {
      recordOnceGrant(onceNetworkGrants, "deny", host, runningExecutions, answer.note);
      return false;
    }
    rememberNetwork("deny", host, answer.note);
    if (answer.duration === Duration.Always) await persistNetwork("deny", host, answer.note);
    return false;
  }

  function rememberNetwork(decision: NetworkDecision, pattern: string, note: string | undefined): void {
    recordGrant(grants, decision, pattern, note);
    pi.appendEntry(NETWORK_ENTRY_TYPE, serializeGrants(grants));
    applyNetwork();
    announceSessionGrantsChanged(pi.events);
  }

  async function persistNetwork(decision: NetworkDecision, pattern: string, note: string | undefined): Promise<void> {
    await updateDomainLists(SETTINGS_FILE, ({ allowedDomains, deniedDomains, deniedDomainReasons }) => {
      const [added, removed] = decision === "allow" ? [allowedDomains, deniedDomains] : [deniedDomains, allowedDomains];
      added.add(pattern);
      removed.delete(pattern);
      if (decision === "deny" && note) deniedDomainReasons.set(pattern, note);
      else deniedDomainReasons.delete(pattern);
    });
  }

  function networkNote(host: string, port: number): string | undefined {
    return networkDenialNote({ grants, once: onceNetworkGrants, settingsReasons: settings?.deniedDomainReasons ?? new Map() }, host, port);
  }

  async function resolveViolations(violations: { line: string }[], promptsLeft: number, profileNames: readonly string[], durations: readonly Duration[]): Promise<{ outcomes: ViolationOutcome[]; promptsUsed: number }> {
    const secrets = secretPaths(homedir());
    const parsed = pathViolations(violations.map(({ line }) => line));
    const outcomes: ViolationOutcome[] = [];
    for (const [index, violation] of parsed.entries()) {
      outcomes.push(await resolveViolation(violation, secrets, index < promptsLeft, profileNames, durations));
    }
    return { outcomes, promptsUsed: Math.min(parsed.length, promptsLeft) };
  }

  async function resolveViolation({ mode, path }: PathViolation, secrets: string[], mayPrompt: boolean, profileNames: readonly string[], durations: readonly Duration[]): Promise<ViolationOutcome> {
    // Resolve before the secret check so a symlink into a secret tree short-circuits and the
    // report names the real secret path. grantPathAccess already resolves internally.
    const resolved = await resolveThroughSymlinks(path);
    if (isSecretPath(resolved, secrets)) return { kind: "secret", path: resolved };
    if (!activeContext?.hasUI) return { kind: "no-ui", mode, path };
    if (!mayPrompt) return { kind: "not-asked", mode, path };
    const outcome = await grantPathAccess(path, mode, activeContext, profileNames, durations);
    if (outcome.kind === "add-to-profile") {
      const entry = selectorText(outcome.grant.selector, homedir());
      await updateProfile(SETTINGS_FILE, outcome.profile, (current) => current && addFilesystemEntry(current, mode, entry));
      return { kind: "added-to-profile", mode, path, profile: outcome.profile };
    }
    if (outcome.kind === "allowed-once") return { kind: "allowed-once", mode, path, grant: outcome.grant };
    if (outcome.kind === "denied") return { kind: "denied", mode, path, note: outcome.note };
    return { kind: "allowed", mode, path };
  }

  function offeredProfiles(): string[] {
    return [...new Set([...runningProfiles.values()].flat())].sort();
  }

  async function profileInputs(): Promise<ProfileInputs> {
    return { agentMode: currentAgentMode(), repositoryRoot: await resolveThroughSymlinks(findRepoRoot()), stateDirectory: stateDirectoryIn(getAgentDir()), homeDirectory: homedir(), instance };
  }

  function rememberProfiledCommand(commandId: string): void {
    profiledCommandIds.push(commandId);
    profiledCommandIds.splice(0, Math.max(0, profiledCommandIds.length - MAX_ADOPTED_COMMANDS));
  }

  // Profiles that apply to this bash call: the requested ones and the ones its command triggers.
  async function profilesForCall(command: string, requested: readonly string[], context: ExtensionContext): Promise<ProfilesForCall> {
    if (subagent && requested.length > 0) throw new Error("Sandbox profiles are not available to subagents.");
    if (subagent) return { names: [], notices: [] };
    const profiles = await loadProfiles(SETTINGS_FILE);
    const applied = new Set<string>();
    for (const profile of requestedProfiles(requested, profiles)) {
      const activation = await activateProfile(profile, { kind: "request", command }, context);
      if (activation.kind === "refused") throw new Error(`${activation.reason} Do not retry with this profile; run the command without it or ask the user.`);
      applied.add(profile.name);
    }
    const notices: string[] = [];
    for (const profile of profiles) {
      if (applied.has(profile.name)) continue;
      const match = matchTrigger(command, profile.triggers);
      if (!match) continue;
      const activation = await activateProfile(profile, { kind: "trigger", match, command }, context);
      if (activation.kind === "activated") applied.add(profile.name);
      else notices.push(`Sandbox profile ${profile.name} was not activated: ${activation.reason}`);
    }
    return { names: [...applied], notices };
  }

  type Activation = { kind: "activated" } | { kind: "refused"; reason: string };

  async function activateProfile(profile: Profile, origin: ActivationOrigin, context: ExtensionContext): Promise<Activation> {
    const resolution = await decideActivation(profile, origin, context);
    if (resolution.remember) {
      rememberProfileDecision(profile.name, resolution.remember);
      persistProfileState();
    }
    const { persist } = resolution;
    if (persist) await updateActivationDecisions(SETTINGS_FILE, (decisions) => recordActivationDecision(decisions, profile.name, persist));
    return resolution.kind === "activate" ? { kind: "activated" } : { kind: "refused", reason: resolution.reason };
  }

  async function decideActivation(profile: Profile, origin: ActivationOrigin, context: ExtensionContext): Promise<ActivationResolution> {
    const outcomeNow = async () => activationOutcome(profile, profileState, { agentMode: currentAgentMode(), hasUI: context.hasUI, always: await loadActivationDecisions(SETTINGS_FILE) });
    const first = await outcomeNow();
    if (first.kind !== "ask") return settledResolution(first);
    return await serialize(async () => {
      // Every triggering call lands here; the first answer settles the ones queued behind it.
      const latest = await outcomeNow();
      if (latest.kind !== "ask") return settledResolution(latest);
      const answer = await askPermission(permissionUI(context.ui), {
        title: activationPrompt(profile, origin),
        subject: `sandbox profile ${profile.name}`,
        scope: profile.name,
        narrower: [],
        durations: ALL_DURATIONS,
        preselected: latest.preselected,
      });
      return resolveActivationAnswer(profile, answer);
    });
  }

  function rememberProfileDecision(name: string, decision: RecordedDecision): void {
    if (decision.decision === "allow") {
      profileState.allowed.add(name);
      profileState.denied.delete(name);
      return;
    }
    profileState.denied.set(name, decision.note);
    profileState.allowed.delete(name);
  }

  function persistProfileState(): void {
    pi.appendEntry(PROFILE_ENTRY_TYPE, serializeProfileState(profileState));
    announceSessionGrantsChanged(pi.events);
  }

  async function runProfileCommand(command: ProfileCommand, context: ExtensionCommandContext): Promise<void> {
    switch (command.kind) {
      case "list": {
        const text = profileListText(await loadProfiles(SETTINGS_FILE), profileState, await loadActivationDecisions(SETTINGS_FILE));
        return context.ui.notify(text, "info");
      }
      case "record": return await recorder.arm(command.name, context);
      case "stop": return await recorder.stop(context);
      case "edit": return await editProfile(command.name, context);
      case "forget": {
        await updateActivationDecisions(SETTINGS_FILE, ({ allowed, denied }) => { allowed.delete(command.name); denied.delete(command.name); });
        profileState.allowed.delete(command.name);
        profileState.denied.delete(command.name);
        persistProfileState();
        return context.ui.notify(`Forgot the stored and session decisions for ${command.name}; it prompts again.`, "info");
      }
      case "delete": {
        if (!(await knownProfile(command.name, context))) return;
        if (!(await context.ui.confirm("Delete sandbox profile", `Delete profile ${command.name} and its stored activation decision?`))) return;
        await updateProfile(SETTINGS_FILE, command.name, () => undefined);
        profileState.allowed.delete(command.name);
        profileState.denied.delete(command.name);
        persistProfileState();
        await refreshNetwork();
        return context.ui.notify(`Deleted profile ${command.name}.`, "info");
      }
    }
  }

  async function knownProfile(name: string, context: ExtensionCommandContext): Promise<boolean> {
    if ((await loadProfiles(SETTINGS_FILE)).some((profile) => profile.name === name)) return true;
    context.ui.notify(`Unknown profile "${name}".`, "error");
    return false;
  }

  async function editProfile(name: string, context: ExtensionCommandContext): Promise<void> {
    const existing = (await loadProfiles(SETTINGS_FILE)).find((profile) => profile.name === name);
    const { name: _name, ...definition } = existing ?? { name, ...emptyProfileDefinition() };
    const edited = await context.ui.editor(`Edit sandbox profile ${name}`, JSON.stringify(definition, null, 2));
    if (edited === undefined) return;
    try {
      const parsed = parseProfileDefinition(JSON.parse(edited), name);
      await updateProfile(SETTINGS_FILE, name, () => parsed);
    } catch (error) {
      return context.ui.notify(`Profile ${name} was not saved: ${(error as Error).message}`, "error");
    }
    await refreshNetwork();
    context.ui.notify(`Saved profile ${name}.`, "info");
  }
}

function reportable<Violation extends { line: string }>(violations: Violation[], repositoryRoot: string): Violation[] {
  return violations.filter(({ line }) => !isRepositoryRootRemoval(line, repositoryRoot));
}

function requestedProfiles(requested: readonly string[], profiles: readonly Profile[]): Profile[] {
  const unknown = requested.filter((name) => !profiles.some((profile) => profile.name === name));
  if (unknown.length > 0) throw new Error(`Unknown profile ${unknown.map((name) => `"${name}"`).join(", ")}. Profiles: ${profiles.map(({ name }) => name).join(", ") || "none"}.`);
  return profiles.filter(({ name }) => requested.includes(name));
}

type ExecOptions = Parameters<BashOperations["exec"]>[2];
type ExecResult = Awaited<ReturnType<BashOperations["exec"]>>;
