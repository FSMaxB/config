import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { AgentMode, isRestricted, MODE_IDENTITIES, RESTRICTED_MODES, type ModeIdentity, type PathRuleStore, type RestrictedMode } from "./agent-mode.ts";
import { FILE_TOOLS } from "./file-tools.ts";
import { readPersistedDecisions, writePersistedDecisions } from "./mode-decisions.ts";
import { activeRestrictedMode, latestModeEntry, type ActiveRestrictedMode } from "./mode-entry.ts";
import { registerModeMessages, SandboxStatus, type ModeMessages, type ModeSnapshot } from "./mode-messages.ts";
import {
  blockedReason,
  DENIAL_CAUSES,
  deniedReason,
  effectiveDenials,
  Interaction,
  startupMode,
  StateRecording,
  Timing,
  toolGate,
  transitionNotice,
} from "./mode-policy.ts";
import {
  addPathRule,
  ALLOW_ALWAYS,
  ALLOW_ONCE,
  ALLOW_SESSION,
  clearPathRules,
  DENY_ALWAYS,
  DENY_ONCE,
  DENY_SESSION,
  initPathPermissions,
  listPathRules,
  normalizePathSelector,
  removePathRule,
  restoreSessionPathRules,
  setAgentMode,
} from "./path-permissions.ts";
import { selectorLabel, type AccessMode, type PathRule, type RuleKind, type RuleTier } from "./path-permission-rules.ts";
import { plansDirectory } from "./plan-file.ts";
import { PLAN_TOOLS } from "./plan-tools.ts";
import { isSandboxActive } from "./sandbox-state.ts";
import { serialize } from "./ui-queue.ts";
import { planToolPermission, trustedReadOnlyToolNames, type ToolPermission } from "./tool-permission-policy.ts";

export interface ModeDefinition {
  identity: ModeIdentity;
  // Whether the mode's startup flag counts on this session_start; plan mode ignores its flag
  // in a fresh handoff session.
  requestedAtStartup(event: { reason: string }, context: ExtensionContext): boolean;
}

export interface RestrictedModeHandle {
  isActive(): boolean;
  flushPendingToggle(context: ExtensionContext): void;
  leave(context: ExtensionContext): void;
  blockedReason(toolName: string): string | undefined;
  // Handles "" (toggle), "grants", "allow <glob>" and "deny <glob>"; false for anything else.
  handleCommand(argument: string, context: ExtensionCommandContext): Promise<boolean>;
  completions(prefix: string): { value: string; label: string }[] | null;
}

// Plan mode and explore mode share one engine per runtime: the mode is a single state, the tool
// gate and the snapshot messages exist once, and each extension only names its mode. The engine
// is found through the runtime's event bus because the extensions load in any order and cannot
// reach each other's closures; a new runtime has a new bus and so starts a new engine.
export function registerRestrictedMode(pi: ExtensionAPI, definition: ModeDefinition): RestrictedModeHandle {
  const engine = discoverEngine(pi) ?? createEngine(pi);
  engine.register(pi, definition);
  const { identity } = definition;

  return {
    isActive: () => engine.mode === identity.mode,
    flushPendingToggle: (context) => engine.flushPendingToggle(context),
    leave: (context) => {
      if (engine.mode === identity.mode) engine.setMode(AgentMode.Execution, context);
    },
    blockedReason: (toolName) => blockedReason(identity.mode, toolName, engine.decisions[identity.mode]),
    handleCommand: (argument, context) => engine.handleCommand(definition, argument, context),
    completions: (prefix) => {
      const completions = ["grants", "allow", "deny"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
      return completions.length > 0 ? completions : null;
    },
  };
}

const DISCOVERY_CHANNEL = "config:restricted-mode:discover";
const INDICATOR_KEY = "agent-mode";
const CLEAR_ALL = "Clear all";
const DONE = "Done";

const UNGATED_TOOLS = new Set([
  // File tools are gated per path by lib/path-permissions.ts rather than per call.
  ...FILE_TOOLS,
  "question",
  // Safe under a restricted mode by construction: the subagent extension caps child
  // tools at what the mode leaves ungated or granted.
  "subagent",
  // Creates only the session scratch directory, which the path rules allow in restricted modes.
  "temp_dir",
  // They reject themselves outside plan mode.
  ...PLAN_TOOLS,
]);

type Decision = "allow-session" | "allow-always" | "deny-session" | "deny-always";

const CHOICE_DECISIONS: Record<string, Decision | undefined> = {
  [ALLOW_SESSION]: "allow-session",
  [ALLOW_ALWAYS]: "allow-always",
  [DENY_SESSION]: "deny-session",
  [DENY_ALWAYS]: "deny-always",
};

interface DecisionStores {
  sessionGrants: Set<string>;
  alwaysGrants: Set<string>;
  // Denials carry the note the user left, so a repeat block can keep repeating the guidance
  // instead of only saying no.
  sessionDenials: Map<string, string | undefined>;
  alwaysDenials: Map<string, string | undefined>;
}

interface DiscoveryRequest {
  engine?: Engine;
}

function discoverEngine(pi: ExtensionAPI): Engine | undefined {
  const request: DiscoveryRequest = {};
  pi.events.emit(DISCOVERY_CHANNEL, request);
  return request.engine;
}

function createEngine(pi: ExtensionAPI): Engine {
  const engine = new Engine(pi);
  pi.events.on(DISCOVERY_CHANNEL, (data) => {
    const request = data as DiscoveryRequest;
    request.engine ??= engine;
  });
  return engine;
}

class Engine {
  mode: AgentMode = AgentMode.Execution;
  readonly decisions: Record<RestrictedMode, DecisionStores> = {
    [AgentMode.Planning]: emptyStores(),
    [AgentMode.Exploring]: emptyStores(),
  };
  private pendingMode: AgentMode | undefined;
  private agentRunning = false;
  private readonly registered = new Map<RestrictedMode, { pi: ExtensionAPI; definition: ModeDefinition }>();
  private readonly messages: ModeMessages;
  private readonly pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
    initPathPermissions(pi);
    this.messages = registerModeMessages(pi, {
      snapshot: () => this.currentSnapshot(),
      projection: (context) => context.sessionManager.buildSessionProjection().messages,
      prepare: (context) => this.flushPendingToggle(context),
    });
    this.wire();
  }

  // Each definition keeps the pi of its own extension because flags can only be read by the
  // extension that registered them.
  register(pi: ExtensionAPI, definition: ModeDefinition): void {
    this.registered.set(definition.identity.mode, { pi, definition });
  }

  async handleCommand(definition: ModeDefinition, argument: string, context: ExtensionCommandContext): Promise<boolean> {
    if (!argument) {
      this.toggle(definition.identity, context);
      return true;
    }
    if (argument === "grants") {
      await this.manageDecisions(definition.identity, context);
      return true;
    }
    const [subcommand, ...rest] = argument.split(/\s+/);
    if (subcommand === "allow" || subcommand === "deny") {
      await addPathRuleInteractively(subcommand, rest.join(" "), definition.identity, context);
      return true;
    }
    return false;
  }

  setMode(target: AgentMode, context: ExtensionContext): void {
    this.mode = target;
    setAgentMode(target);
    this.refreshIndicators(context);
    // Every switch records each mode, so the branch always says which one is enabled.
    for (const mode of RESTRICTED_MODES) this.persist(mode);
    this.messages.announce(context);
  }

  flushPendingToggle(context: ExtensionContext): void {
    if (this.pendingMode === undefined) return;

    const target = this.pendingMode;
    this.pendingMode = undefined;
    if (target === this.mode) {
      this.refreshIndicators(context);
      return;
    }
    const from = this.mode;
    this.setMode(target, context);
    context.ui.notify(transitionNotice(from, target, Timing.Immediate));
  }

  private wire(): void {
    const { pi } = this;

    pi.on("tool_call", async (event, context) => {
      this.flushPendingToggle(context);
      const outcome = this.gate(event.toolName, context.hasUI ? Interaction.Available : Interaction.Unavailable);
      if (outcome.kind === "run") return;
      if (outcome.kind === "block") return { block: true, reason: outcome.reason };
      return await serialize(() => this.requestPermission(event, context));
    });

    pi.on("agent_start", async () => {
      this.agentRunning = true;
    });

    pi.on("agent_end", async (_event, context) => {
      this.agentRunning = false;
      this.flushPendingToggle(context);
    });

    pi.on("session_start", async (event, context) => {
      const restored = await this.restoreBranchState(context);
      const requested = [...this.registered.values()]
        .filter(({ pi: owner, definition }) => owner.getFlag(definition.identity.command) === true && definition.requestedAtStartup(event, context))
        .map(({ definition }) => definition.identity.mode);
      if (requested.length > 1) {
        context.ui.notify("Both --plan and --explore were given; starting in plan mode.", "warning");
      }
      const { mode, recording } = startupMode(restored, requested);
      this.mode = mode;
      if (recording === StateRecording.Record) for (const restricted of RESTRICTED_MODES) this.persist(restricted);
      this.applyRestoredState(context);
    });

    // The selected branch's recorded mode wins over the startup flag here: navigating is not a restart.
    pi.on("session_tree", async (_event, context) => {
      await this.restoreBranchState(context);
      this.applyRestoredState(context);
    });
  }

  private currentSnapshot(): ModeSnapshot {
    return {
      mode: this.mode,
      plansDirectory: plansDirectory(),
      sandbox: isSandboxActive() ? SandboxStatus.Active : SandboxStatus.Inactive,
      denials: effectiveDenials(this.activeStores()),
    };
  }

  private activeStores(): DecisionStores {
    return isRestricted(this.mode) ? this.decisions[this.mode] : emptyStores();
  }

  private gate(toolName: string, interaction: Interaction) {
    return toolGate(toolName, { mode: this.mode, denials: this.activeStores(), permission: this.permission(toolName), interaction });
  }

  private permission(toolName: string): ToolPermission {
    // The sandbox makes bash read-only in restricted modes at the OS level; without it bash stays gated per call.
    if (toolName === "bash" && isSandboxActive()) return "allow";
    const { sessionGrants, alwaysGrants, sessionDenials, alwaysDenials } = this.activeStores();
    return planToolPermission(
      toolName,
      { sessionGrants, alwaysGrants, sessionDenials: sessionDenials.keys(), alwaysDenials: alwaysDenials.keys() },
      UNGATED_TOOLS,
      trustedReadOnlyToolNames(this.pi.getAllTools()),
    );
  }

  private async requestPermission(event: ToolCallEvent, context: ExtensionContext) {
    // An earlier prompt from the same batch may have decided this tool while we queued.
    const queued = this.gate(event.toolName, Interaction.Available);
    if (queued.kind === "block") return { block: true, reason: queued.reason };
    if (queued.kind === "run") return undefined;

    const { mode } = this;
    if (!isRestricted(mode)) return undefined;
    const choice = await context.ui.select(
      `${MODE_IDENTITIES[mode].label} — allow ${event.toolName}?\n\n  ${summarizeInput(event)}`,
      [ALLOW_ONCE, ALLOW_SESSION, ALLOW_ALWAYS, DENY_ONCE, DENY_SESSION, DENY_ALWAYS],
    );

    if (choice === ALLOW_ONCE) return undefined;
    const decision = choice === undefined ? undefined : CHOICE_DECISIONS[choice];
    if (decision === "allow-session" || decision === "allow-always") {
      await this.record(mode, event.toolName, decision, context);
      return undefined;
    }

    // Dismissing the prompt denies the call without stopping to ask for a note.
    const note = choice === undefined ? undefined : await askDenyNote(context);
    if (decision) await this.record(mode, event.toolName, decision, context, note);
    const cause = decision ? DENIAL_CAUSES[decision] : "the user denied this call";
    return { block: true, reason: deniedReason(mode, event.toolName, cause, note) };
  }

  // The most recent decision wins outright, so a tool never sits in two stores and
  // a narrow grant can always override an earlier "always" denial.
  private async record(mode: RestrictedMode, toolName: string, decision: Decision, context: ExtensionContext, note?: string): Promise<void> {
    const stores = this.decisions[mode];
    for (const store of [stores.sessionGrants, stores.alwaysGrants, stores.sessionDenials, stores.alwaysDenials]) {
      store.delete(toolName);
    }
    switch (decision) {
      case "allow-session":
        stores.sessionGrants.add(toolName);
        break;
      case "allow-always":
        stores.alwaysGrants.add(toolName);
        break;
      case "deny-session":
        stores.sessionDenials.set(toolName, note);
        break;
      case "deny-always":
        stores.alwaysDenials.set(toolName, note);
        break;
    }
    await this.save(mode, context);
  }

  private async save(mode: RestrictedMode, context: ExtensionContext): Promise<void> {
    this.persist(mode);
    const { alwaysGrants, alwaysDenials } = this.decisions[mode];
    await writePersistedDecisions(mode, alwaysGrants, alwaysDenials).catch((error: Error) => {
      context.ui.notify(`${MODE_IDENTITIES[mode].label} decision applies to this session only, it was not saved: ${error.message}`, "error");
    });
    this.messages.announce(context);
  }

  private persist(mode: RestrictedMode): void {
    const { sessionGrants, sessionDenials } = this.decisions[mode];
    this.pi.appendEntry(MODE_IDENTITIES[mode].entryType, {
      enabled: this.mode === mode,
      sessionGrants: [...sessionGrants],
      sessionDenials: [...sessionDenials].map(([name, note]) => ({ name, note })),
    });
  }

  private toggle(identity: ModeIdentity, context: ExtensionContext): void {
    const current = this.pendingMode ?? this.mode;
    const target = current === identity.mode ? AgentMode.Execution : identity.mode;
    if (this.agentRunning) {
      this.pendingMode = target;
      this.refreshIndicators(context);
      context.ui.notify(transitionNotice(current, target, Timing.Deferred));
      return;
    }
    this.setMode(target, context);
    context.ui.notify(transitionNotice(current, target, Timing.Immediate));
  }

  private refreshIndicators(context: ExtensionContext): void {
    const { theme } = context.ui;
    const pending = this.pendingMode !== this.mode ? this.pendingMode : undefined;
    const status = isRestricted(this.mode)
      ? theme.fg("warning", `${MODE_IDENTITIES[this.mode].statusIcon} ${MODE_IDENTITIES[this.mode].command}`)
      : undefined;
    context.ui.setStatus(INDICATOR_KEY, status);
    context.ui.setWidget(INDICATOR_KEY, modeBanner(theme, this.mode, pending), { placement: "aboveEditor" });
  }

  private async restoreBranchState(context: ExtensionContext): Promise<ActiveRestrictedMode> {
    this.messages.reset();
    for (const mode of RESTRICTED_MODES) {
      const stores = this.decisions[mode];
      for (const store of [stores.sessionGrants, stores.alwaysGrants, stores.sessionDenials, stores.alwaysDenials]) {
        store.clear();
      }

      const { alwaysAllowed, alwaysDenied } = await readPersistedDecisions(mode).catch((error: Error) => {
        context.ui.notify(`${error.message} ${MODE_IDENTITIES[mode].label} decisions saved with "always" were not loaded.`, "warning");
        return { alwaysAllowed: [], alwaysDenied: [] };
      });
      for (const toolName of alwaysAllowed) stores.alwaysGrants.add(toolName);
      for (const { name, note } of alwaysDenied) stores.alwaysDenials.set(name, note);

      const restored = latestModeEntry(context.sessionManager, MODE_IDENTITIES[mode].entryType);
      for (const toolName of restored?.sessionGrants ?? []) stores.sessionGrants.add(toolName);
      for (const { name, note } of restored?.sessionDenials ?? []) stores.sessionDenials.set(name, note);
    }

    const active = activeRestrictedMode(context.sessionManager);
    this.mode = active.mode;
    restoreSessionPathRules({ getEntries: () => context.sessionManager.getBranch() });
    return active;
  }

  private applyRestoredState(context: ExtensionContext): void {
    setAgentMode(this.mode);
    this.refreshIndicators(context);
  }

  private async manageDecisions(identity: ModeIdentity, context: ExtensionContext): Promise<void> {
    const { label, mode, pathRuleStore } = identity;
    if (!context.hasUI) {
      context.ui.notify(`Managing ${label.toLowerCase()} decisions needs an interactive UI.`, "error");
      return;
    }

    const stores = this.decisions[mode];
    while (true) {
      const entries = listDecisions(stores, await listPathRules(pathRuleStore), pathRuleStore);
      if (entries.length === 0) {
        context.ui.notify(`No ${label.toLowerCase()} grants, denials or path rules recorded.`);
        return;
      }

      const labels = entries.map((entry) => entry.label);
      const choice = await context.ui.select(`${label} decisions — pick one to remove`, [...labels, CLEAR_ALL, DONE]);

      if (choice === CLEAR_ALL) {
        for (const store of [stores.sessionGrants, stores.alwaysGrants, stores.sessionDenials, stores.alwaysDenials]) {
          store.clear();
        }
        await this.save(mode, context);
        await clearPathRules(pathRuleStore);
        context.ui.notify(`Cleared all ${label.toLowerCase()} grants, denials and path rules.`);
        return;
      }

      const entry = entries[labels.indexOf(choice ?? "")];
      if (!entry) return;

      await entry.remove();
      await this.save(mode, context);
    }
  }
}

function emptyStores(): DecisionStores {
  return { sessionGrants: new Set(), alwaysGrants: new Set(), sessionDenials: new Map(), alwaysDenials: new Map() };
}

async function askDenyNote(context: ExtensionContext): Promise<string | undefined> {
  const note = await context.ui.input("What should the agent do instead?", "Optional — leave empty to just deny");
  return note?.trim() || undefined;
}

function modeBanner(theme: Theme, mode: AgentMode, pending: AgentMode | undefined): string[] | undefined {
  if (!isRestricted(mode)) {
    if (pending === undefined || !isRestricted(pending)) return undefined;
    const { statusIcon, label } = MODE_IDENTITIES[pending];
    return [theme.fg("dim", `${statusIcon} ${label.toLowerCase()} starts at the next tool call`)];
  }

  const { statusIcon, label, command } = MODE_IDENTITIES[mode];
  const title = theme.fg("warning", theme.bold(`${statusIcon} ${label.toUpperCase()}`));
  if (pending === undefined) {
    return [title + theme.fg("dim", ` — read-only tools run freely, everything else asks. /${command} to exit`)];
  }
  const hint = isRestricted(pending)
    ? ` — switching to ${MODE_IDENTITIES[pending].label.toLowerCase()} at the next tool call`
    : " — ending at the next tool call";
  return [title + theme.fg("dim", hint)];
}

interface DecisionEntry {
  label: string;
  remove: () => void | Promise<void>;
}

function listDecisions(stores: DecisionStores, pathRules: PathRule[], pathRuleStore: PathRuleStore): DecisionEntry[] {
  const grants: [Set<string>, string][] = [
    [stores.sessionGrants, "allow (session)"],
    [stores.alwaysGrants, "allow (always)"],
  ];
  const denials: [Map<string, string | undefined>, string][] = [
    [stores.sessionDenials, "deny (session)"],
    [stores.alwaysDenials, "deny (always)"],
  ];

  return [
    ...grants.flatMap(([store, scope]) =>
      [...store].sort().map((toolName) => ({
        label: `${toolName} — ${scope}`,
        remove: () => void store.delete(toolName),
      })),
    ),
    ...denials.flatMap(([store, scope]) =>
      [...store.keys()].sort().map((toolName) => {
        const note = store.get(toolName);
        return {
          label: note ? `${toolName} — ${scope}: ${note}` : `${toolName} — ${scope}`,
          remove: () => void store.delete(toolName),
        };
      }),
    ),
    ...pathRules.map((rule) => ({
      label: `${rule.mode} ${rule.kind} ${selectorLabel(rule.selector)} — path (${rule.tier})`,
      remove: () => removePathRule(rule, pathRuleStore),
    })),
  ];
}

async function addPathRuleInteractively(
  kind: RuleKind,
  pattern: string,
  { command, pathRuleStore }: ModeIdentity,
  context: ExtensionCommandContext,
): Promise<void> {
  if (!pattern) {
    context.ui.notify(`Usage: /${command} ${kind} <path-or-glob>`, "error");
    return;
  }
  if (!context.hasUI) {
    context.ui.notify("Adding path rules needs an interactive UI.", "error");
    return;
  }
  const modeChoice = await context.ui.select(`${kind} ${pattern} for which access?`, ["read", "write", "read and write"]);
  if (modeChoice === undefined) return;
  const tierChoice = await context.ui.select("For how long?", ["This session", "Always"]);
  if (tierChoice === undefined) return;
  const tier: RuleTier = tierChoice === "Always" ? "always" : "session";
  const selector = await normalizePathSelector(pattern, context.cwd);
  const modes: AccessMode[] = modeChoice === "read and write" ? ["read", "write"] : [modeChoice as AccessMode];
  for (const mode of modes) await addPathRule({ mode, kind, tier, selector }, pathRuleStore);
  context.ui.notify(`Path rule added: ${kind} ${modes.join("+")} ${selectorLabel(selector)} (${tier}).`);
}

function summarizeInput(event: ToolCallEvent): string {
  const input = event.input as Record<string, unknown>;
  const detail =
    typeof input.command === "string"
      ? input.command
      : typeof input.path === "string"
        ? input.path
        : JSON.stringify(input);
  return detail.length > 200 ? `${detail.slice(0, 197)}...` : detail;
}
