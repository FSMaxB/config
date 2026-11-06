import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createBashToolDefinition, createLocalBashOperations, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { BashOperations, BashToolDetails, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { ALLOW_ALWAYS, ALLOW_ONCE, ALLOW_SESSION, DENY_ALWAYS, DENY_ONCE, DENY_SESSION, currentAgentMode, currentPolicy, grantPathAccess, type OnceGrant } from "../../lib/path-permissions.ts";
import { registerToolWithGuidelines } from "../../lib/register-tool.ts";
import { findRepoRoot, resolveThroughSymlinks } from "../../lib/repo.ts";
import { markSandboxActive } from "../../lib/sandbox-state.ts";
import { selectWithDefault } from "../../lib/select-with-default.ts";
import { latestCustomData } from "../../lib/session-entries.ts";
import { serialize } from "../../lib/ui-queue.ts";
import { bypassOutcome, bypassPrompt, resolveChoice, type BypassAuthorization, type SessionDecision } from "./bypass.ts";
import { credentialEnvVars } from "./credentials.ts";
import { NETWORK_ENTRY_TYPE, emptyGrants, networkConfig, parseGrants, recordGrant, serializeGrants, type NetworkGrants } from "./network-grants.ts";
import { filesystemConfig, secretPaths, type PolicyOptions } from "./policy.ts";
import { loadSettings, updateDomainLists, type Settings } from "./settings.ts";
import { scanVcsLayout, vcsWriteRules, type VcsWriteRules } from "./vcs-policy.ts";
import { isSecretPath, pathViolations, type PathViolation } from "./violations.ts";
import { nextStep, successViolationReport, violationReport, type NextStep, type ViolationOutcome } from "./violation-outcomes.ts";

const SANDBOX_NOTE =
  "Commands run inside an OS sandbox that enforces the same read/write path rules as the file tools, with no network except allowed hosts. Denied paths are reported in a <sandbox_violations> block and the user is asked to grant them; after a grant the command has to be rerun, unless the user allowed it once: then the sandbox reruns it itself and the rerun's output follows the report. Never try to work around a denial. " +
  "Set unsandboxed to true only for a command the sandbox itself breaks (ssh git remotes, programs that ignore proxy variables, listening sockets); the user confirms every unsandboxed command first, and subagents cannot use it.";

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

const SANDBOX_TEMPORARY_DIRECTORY = "/tmp/claude";
const SETTINGS_FILE = join(getAgentDir(), "sandbox.json");

interface Runtime {
  operations: BashOperations;
  setActiveContext(context: ExtensionContext): void;
  authorizeBypass(command: string, context: ExtensionContext): Promise<BypassAuthorization>;
  restoreGrants(sessionManager: { getEntries(): readonly unknown[] }): void;
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
  pi.on("session_start", (_event, context) => runtime.restoreGrants(context.sessionManager));
  // srt's proxies and macOS log monitor keep the event loop alive, so without this a `pi -p`
  // subagent child that ran bash never exits.
  pi.on("session_shutdown", () => runtime.shutdown());
  registerToolWithGuidelines(pi, sandboxedBash(cwd, runtime));
}

function sandboxedBash(cwd: string, runtime: Runtime) {
  const sandboxed = createBashToolDefinition(cwd, { operations: runtime.operations });
  const unsandboxed = createBashToolDefinition(cwd);
  const parameters = Type.Object({
    ...sandboxed.parameters.properties,
    unsandboxed: Type.Optional(Type.Boolean({ description: "Run outside the sandbox after the user confirms; only for a command the sandbox itself breaks" })),
  });
  const definition: ToolDefinition<typeof parameters, BashToolDetails | undefined, BashRenderState> = {
    ...withSandboxNote(sandboxed),
    parameters,
    async execute(toolCallId, params, signal, onUpdate, context) {
      if (params.unsandboxed !== true) {
        runtime.setActiveContext(context);
        return await sandboxed.execute(toolCallId, params, signal, onUpdate, context);
      }
      const authorization = await runtime.authorizeBypass(params.command, context);
      if (authorization.kind === "refuse") throw new Error(authorization.reason);
      return await unsandboxed.execute(toolCallId, params, signal, onUpdate, context);
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
  // Deliberately not persisted in the session: a resumed session asks again before bypassing the sandbox.
  let bypassDecision: SessionDecision | undefined;
  let warnedAboutConfigIds = false;

  const operations: BashOperations = {
    async exec(command, cwd, options) {
      initialization ??= initialize().catch((error) => {
        initialization = undefined;
        throw error;
      });
      await initialization;
      return await runSandboxed(command, cwd, options, [], MAX_PATH_PROMPTS_PER_COMMAND);
    },
  };

  return {
    operations,
    setActiveContext(context) { activeContext = context; },
    authorizeBypass,
    restoreGrants(sessionManager) {
      grants = parseGrants(latestCustomData(sessionManager, NETWORK_ENTRY_TYPE));
      applyNetwork();
    },
    async shutdown() {
      const pending = initialization;
      initialization = undefined;
      if (!pending) return;
      // A failed initialization can still have started proxies or the log monitor.
      await pending.catch(() => undefined);
      await sandboxManager?.reset();
    },
  };

  // Once-grants live only in this recursion, so they never outlast the command they were given for.
  // The prompt budget is per command too: each rerun draws from what the previous runs left.
  async function runSandboxed(command: string, cwd: string, options: ExecOptions, onceGrants: OnceGrant[], promptsLeft: number): Promise<ExecResult> {
    const { result, step, promptsUsed } = await runOnce(command, cwd, options, onceGrants, promptsLeft);
    if (step.kind === "return" || options.signal?.aborted) return result;
    return await runSandboxed(command, cwd, options, [...onceGrants, ...step.grants], promptsLeft - promptsUsed);
  }

  async function runOnce(command: string, cwd: string, options: ExecOptions, onceGrants: OnceGrant[], promptsLeft: number): Promise<{ result: ExecResult; step: NextStep; promptsUsed: number }> {
    const commandId = randomUUID();
    const vcs = await vcsRules();
    const filesystem = filesystemConfig(await currentPolicy(onceGrants), policyOptions(vcs));
    warnAboutMissingConfigIds(vcs, filesystem.denyWrite);
    try {
      const wrapped = await manager().wrapWithSandbox(command, undefined, { filesystem }, options.signal, { commandId, commandText: command });
      const result = await stock.exec(wrapped, cwd, options);
      if (result.exitCode === 0) {
        // Linux events arrive over the monitor socket and are best-effort after exit, so the success
        // path pays one poll on Linux; macOS reports asynchronously via `log stream`, so it polls
        // until the count settles like the failure path.
        const violations = process.platform === "linux"
          ? await readViolationsAfterOneWait(commandId)
          : await collectViolations(commandId);
        const report = successViolationReport(pathViolations(violations.map(({ line }) => line)), filesystem, currentAgentMode());
        if (report) options.onData(Buffer.from(report));
        return { result, step: { kind: "return" }, promptsUsed: 0 };
      }
      const violations = await collectViolations(commandId);
      if (violations.length === 0) return { result, step: { kind: "return" }, promptsUsed: 0 };
      options.onData(Buffer.from(manager().annotateStderrWithSandboxFailures(commandId, "")));
      const { outcomes, promptsUsed } = await resolveViolations(violations, promptsLeft);
      const step = nextStep(outcomes);
      options.onData(Buffer.from(violationReport(outcomes, step, currentAgentMode())));
      return { result, step, promptsUsed };
    } finally {
      manager().cleanupAfterCommand();
    }
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
    await manager().initialize(
      {
        network: networkConfig(settings, grants, subagent),
        filesystem: filesystemConfig(await currentPolicy(), policyOptions(await vcsRules())),
        credentials: { envVars: credentialEnvVars() },
        allowPty: false,
      },
      askNetwork,
      true,
    );
  }

  function policyOptions(vcs: VcsWriteRules): PolicyOptions {
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

  function applyNetwork(): void {
    if (!sandboxManager || !settings) return;
    const config = sandboxManager.getConfig();
    if (!config) return;
    sandboxManager.updateConfig({ ...config, network: { ...config.network, ...networkConfig(settings, grants, subagent) } });
  }

  // The success-path report is best effort on Linux, where events arrive over the monitor socket, so
  // it pays one poll interval instead of waiting for the count to settle like a failed command does.
  async function readViolationsAfterOneWait(commandId: string) {
    await new Promise((resolve) => setTimeout(resolve, VIOLATION_POLL_MILLISECONDS));
    return manager().getSandboxViolationStore().getViolationsForCommand(commandId);
  }

  async function collectViolations(commandId: string) {
    const store = manager().getSandboxViolationStore();
    let previousCount = -1;
    for (let poll = 0; poll < VIOLATION_MAX_POLLS; poll += 1) {
      await new Promise((resolve) => setTimeout(resolve, VIOLATION_POLL_MILLISECONDS));
      const count = store.getViolationsForCommand(commandId).length;
      if (count === previousCount) break;
      previousCount = count;
    }
    return store.getViolationsForCommand(commandId);
  }

  async function authorizeBypass(command: string, context: ExtensionContext): Promise<BypassAuthorization> {
    const outcome = bypassOutcome({ agentMode: currentAgentMode(), subagent, hasUI: context.hasUI, sessionDecision: bypassDecision });
    if (outcome.kind !== "ask") return outcome;
    const choice = await serialize(() => selectWithDefault(context.ui, bypassPrompt(command), outcome.choices, outcome.defaultChoice, "permission"));
    const { authorization, remember } = resolveChoice(choice);
    if (remember) bypassDecision = remember;
    return authorization;
  }

  async function askNetwork({ host, port }: { host: string; port: number | undefined }): Promise<boolean> {
    const context = activeContext;
    if (!context?.hasUI) return false;
    const destination = port === undefined ? host : `${host}:${port}`;
    const choice = await serialize(() =>
      context.ui.select(`Sandbox: allow network access to ${destination}?\n\n  Allowing grants ${host} (all ports)`, [ALLOW_ONCE, ALLOW_SESSION, ALLOW_ALWAYS, DENY_ONCE, DENY_SESSION, DENY_ALWAYS]),
    );
    if (choice === ALLOW_ONCE) return true;
    if (choice === ALLOW_SESSION) { rememberNetwork("allow", host); return true; }
    if (choice === ALLOW_ALWAYS) { rememberNetwork("allow", host); await persistNetwork("allow", host); return true; }
    if (choice === DENY_SESSION) { rememberNetwork("deny", host); return false; }
    if (choice === DENY_ALWAYS) { rememberNetwork("deny", host); await persistNetwork("deny", host); return false; }
    return false;
  }

  function rememberNetwork(decision: "allow" | "deny", host: string): void {
    recordGrant(grants, decision, host);
    pi.appendEntry(NETWORK_ENTRY_TYPE, serializeGrants(grants));
    applyNetwork();
  }

  async function persistNetwork(decision: "allow" | "deny", host: string): Promise<void> {
    await updateDomainLists(SETTINGS_FILE, ({ allowedDomains, deniedDomains }) => {
      const [added, removed] = decision === "allow" ? [allowedDomains, deniedDomains] : [deniedDomains, allowedDomains];
      added.add(host);
      removed.delete(host);
    });
  }

  async function resolveViolations(violations: { line: string }[], promptsLeft: number): Promise<{ outcomes: ViolationOutcome[]; promptsUsed: number }> {
    const secrets = secretPaths(homedir());
    const parsed = pathViolations(violations.map(({ line }) => line));
    const outcomes: ViolationOutcome[] = [];
    for (const [index, violation] of parsed.entries()) {
      outcomes.push(await resolveViolation(violation, secrets, index < promptsLeft));
    }
    return { outcomes, promptsUsed: Math.min(parsed.length, promptsLeft) };
  }

  async function resolveViolation({ mode, path }: PathViolation, secrets: string[], mayPrompt: boolean): Promise<ViolationOutcome> {
    // Resolve before the secret check so a symlink into a secret tree short-circuits and the
    // report names the real secret path. grantPathAccess already resolves internally.
    const resolved = await resolveThroughSymlinks(path);
    if (isSecretPath(resolved, secrets)) return { kind: "secret", path: resolved };
    if (!activeContext?.hasUI) return { kind: "no-ui", mode, path };
    if (!mayPrompt) return { kind: "not-asked", mode, path };
    const outcome = await grantPathAccess(path, mode, activeContext);
    if (outcome.kind === "allowed-once") return { kind: "allowed-once", mode, path, grant: outcome.grant };
    return { kind: outcome.kind, mode, path };
  }
}

type ExecOptions = Parameters<BashOperations["exec"]>[2];
type ExecResult = Awaited<ReturnType<BashOperations["exec"]>>;
