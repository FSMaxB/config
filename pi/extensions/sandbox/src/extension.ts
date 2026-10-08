import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { SandboxManager, type FilesystemConfig } from "@anthropic-ai/sandbox-runtime";
import { createBashToolDefinition, createLocalBashOperations, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { BashOperations, BashToolDetails, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { readOnlyRepositoryNotice } from "../../lib/path-permission-rules.ts";
import { ALLOW_ALWAYS, ALLOW_ONCE, ALLOW_SESSION, DENY_ALWAYS, DENY_ONCE, DENY_SESSION, currentAgentMode, currentPolicy, grantPathAccess } from "../../lib/path-permissions.ts";
import { registerToolWithGuidelines } from "../../lib/register-tool.ts";
import { markSandboxActive } from "../../lib/sandbox-state.ts";
import { selectWithDefault } from "../../lib/select-with-default.ts";
import { latestCustomData } from "../../lib/session-entries.ts";
import { serialize } from "../../lib/ui-queue.ts";
import { bypassOutcome, bypassPrompt, resolveChoice, type BypassAuthorization, type SessionDecision } from "./bypass.ts";
import { credentialEnvVars } from "./credentials.ts";
import { NETWORK_ENTRY_TYPE, effectiveNetwork, emptyGrants, parseGrants, recordGrant, serializeGrants, type NetworkGrants } from "./network-grants.ts";
import { filesystemConfig, secretPaths, type PolicyOptions } from "./policy.ts";
import { loadSettings, updateDomainLists, type Settings } from "./settings.ts";
import { discardedWrites, isSecretPath, pathViolations, type PathViolation } from "./violations.ts";

const SANDBOX_NOTE =
  "Commands run inside an OS sandbox that enforces the same read/write path rules as the file tools, with no network except allowed hosts. Denied paths are reported in a <sandbox_violations> block and the user is asked to grant them; after a grant the command has to be rerun. Never try to work around a denial. " +
  "Set unsandboxed to true only for a command the sandbox itself breaks (ssh git remotes, programs that ignore proxy variables, listening sockets); the user confirms every unsandboxed command first, and subagents cannot use it.";

const INSTALL_HINT =
  "Install with: sudo pacman -S bubblewrap socat ripgrep (Arch) or apt install bubblewrap socat ripgrep (Debian/Ubuntu, plus sysctl kernel.apparmor_restrict_unprivileged_userns=0 and apparmor_parser -R /etc/apparmor.d/bwrap-userns-restrict). Set PI_SANDBOX=0 to run without the sandbox.";

// macOS reports violations asynchronously through `log stream`, so they land a moment after the child
// exits, sometimes later than any single fixed wait. Keep polling until the count stops changing.
const VIOLATION_POLL_MILLISECONDS = 250;
const VIOLATION_MAX_POLLS = 6;
const MAX_PATH_PROMPTS_PER_COMMAND = 5;

const SANDBOX_TEMPORARY_DIRECTORY = "/tmp/claude";
const SETTINGS_FILE = join(getAgentDir(), "sandbox.json");

interface Runtime {
  operations: BashOperations;
  setActiveContext(context: ExtensionContext): void;
  authorizeBypass(command: string, context: ExtensionContext): Promise<BypassAuthorization>;
  restoreGrants(sessionManager: { getEntries(): readonly unknown[] }): void;
}

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
  let activeContext: ExtensionContext | undefined;
  let initialization: Promise<void> | undefined;
  let settings: Settings | undefined;
  let grants: NetworkGrants = emptyGrants();
  // Deliberately not persisted in the session: a resumed session asks again before bypassing the sandbox.
  let bypassDecision: SessionDecision | undefined;

  const operations: BashOperations = {
    async exec(command, cwd, options) {
      initialization ??= initialize().catch((error) => {
        initialization = undefined;
        throw error;
      });
      await initialization;
      const commandId = randomUUID();
      const filesystem = filesystemConfig(await currentPolicy(), policyOptions());
      try {
        const wrapped = await SandboxManager.wrapWithSandbox(command, undefined, { filesystem }, options.signal, { commandId, commandText: command });
        const result = await stock.exec(wrapped, cwd, options);
        if (result.exitCode === 0 && process.platform !== "linux") return result;
        if (result.exitCode === 0) {
          const report = discardedWritesReport(await readViolationsAfterOneWait(commandId), filesystem);
          if (report) options.onData(Buffer.from(report));
          return result;
        }
        const violations = await collectViolations(commandId);
        if (violations.length === 0) return result;
        options.onData(Buffer.from(SandboxManager.annotateStderrWithSandboxFailures(commandId, "")));
        options.onData(Buffer.from(await promptForPaths(violations)));
        return result;
      } finally {
        SandboxManager.cleanupAfterCommand();
      }
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
  };

  async function initialize(): Promise<void> {
    settings = await loadSettings(SETTINGS_FILE);
    // srt points TMPDIR here and always allows writes to it, but leaves creating it to the embedder.
    await mkdir(SANDBOX_TEMPORARY_DIRECTORY, { recursive: true, mode: 0o700 });
    const { errors, warnings } = await SandboxManager.checkDependenciesAsync();
    // Without the seccomp filter a sandboxed process could open unix sockets to escape the network rules.
    const seccompMissing = process.platform === "linux" ? warnings.filter((warning) => /seccomp/i.test(warning)) : [];
    const problems = [...errors, ...seccompMissing];
    if (problems.length > 0) throw new Error(`Sandboxed bash is unavailable: ${problems.join("; ")}. ${INSTALL_HINT}`);
    await SandboxManager.initialize(
      {
        network: { ...effectiveNetwork(settings, grants), allowUnixSockets: settings.allowUnixSockets, allowLocalBinding: settings.allowLocalBinding },
        filesystem: filesystemConfig(await currentPolicy(), policyOptions()),
        credentials: { envVars: credentialEnvVars() },
        allowPty: false,
      },
      askNetwork,
      true,
    );
  }

  function policyOptions(): PolicyOptions {
    if (!settings) throw new Error("Sandbox settings are not loaded.");
    return { platform: process.platform as PolicyOptions["platform"], homeDirectory: homedir(), toolchainRead: settings.toolchainRead, extraDenyRead: settings.extraDenyRead };
  }

  function applyNetwork(): void {
    const config = SandboxManager.getConfig();
    if (!config || !settings) return;
    SandboxManager.updateConfig({ ...config, network: { ...config.network, ...effectiveNetwork(settings, grants) } });
  }

  // The discarded-write report is best effort and runs on every successful Linux command, so it pays one
  // poll interval instead of waiting for the count to settle like a failed command does.
  async function readViolationsAfterOneWait(commandId: string) {
    await new Promise((resolve) => setTimeout(resolve, VIOLATION_POLL_MILLISECONDS));
    return SandboxManager.getSandboxViolationStore().getViolationsForCommand(commandId);
  }

  async function collectViolations(commandId: string) {
    const store = SandboxManager.getSandboxViolationStore();
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
    const outcome = bypassOutcome({ agentMode: currentAgentMode(), subagent: Boolean(process.env.PI_SUBAGENT_CHILD), hasUI: context.hasUI, sessionDecision: bypassDecision });
    if (outcome.kind !== "ask") return outcome;
    const choice = await serialize(() => selectWithDefault(context.ui, bypassPrompt(command), outcome.choices, outcome.defaultChoice));
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

  async function promptForPaths(violations: { line: string }[]): Promise<string> {
    const secrets = secretPaths(homedir());
    const lines: string[] = [];
    for (const [index, violation] of pathViolations(violations.map(({ line }) => line)).entries()) {
      lines.push(await resolveViolation(violation, secrets, index < MAX_PATH_PROMPTS_PER_COMMAND));
    }
    return `\n${lines.join("\n")}\n`;
  }

  async function resolveViolation({ mode, path }: PathViolation, secrets: string[], mayPrompt: boolean): Promise<string> {
    if (isSecretPath(path, secrets)) return `${path} is on the sandbox secret list and cannot be granted.`;
    const notice = readOnlyRepositoryNotice(mode, currentAgentMode());
    if (!activeContext?.hasUI) return `${path} is not covered by the ${mode} path rules and there is no interactive UI to ask.${notice}`;
    if (!mayPrompt) return `${path} is not covered by the ${mode} path rules; too many paths were denied to ask about each one.${notice}`;
    const outcome = await grantPathAccess(path, mode, activeContext);
    return outcome === "allowed" ? `${mode} access to ${path} was granted; rerun the command.` : `${mode} access to ${path} was denied; do not retry it.${notice}`;
  }
}

function discardedWritesReport(violations: { line: string }[], filesystem: FilesystemConfig): string {
  const discarded = discardedWrites(pathViolations(violations.map(({ line }) => line)), filesystem);
  if (discarded.length === 0) return "";
  const lines = discarded.map(({ path }) => `${path} is not covered by the write path rules; the write was discarded and nothing reached the real filesystem.`);
  return `\n<sandbox_violations>\n${lines.join("\n")}${readOnlyRepositoryNotice("write", currentAgentMode())}\n</sandbox_violations>\n`;
}
