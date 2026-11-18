import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { AgentMode, isRestricted, MODE_IDENTITIES, RESTRICTED_MODES, storeForMode } from "./agent-mode.ts";
import type { ModeIdentity, PathRuleStore, RestrictedMode } from "./agent-mode.ts";
import { errorMessage } from "./errors.ts";
import { FILE_TOOLS } from "./file-tools.ts";
import { readPersistedDecisions, writePersistedDecisions } from "./mode-decisions.ts";
import { activeRestrictedMode, latestModeEntry } from "./mode-entry.ts";
import type { ActiveRestrictedMode } from "./mode-entry.ts";
import { registerModeMessages } from "./mode-messages.ts";
import type { ModeMessages, ModeSnapshot } from "./mode-messages.ts";
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
import type { ToolGate } from "./mode-policy.ts";
import {
  clearPathRules,
  initPathPermissions,
  listPathRules,
  restoreSessionPathRules,
  setAgentMode,
} from "./path-permissions.ts";
import type { PathRule } from "./path-permission-rules.ts";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { completionItems, RULE_SUBCOMMANDS } from "./completions.ts";
import { addPathRuleInteractively, manageDecisions, pathRuleEntries } from "./path-rule-commands.ts";
import type { DecisionEntry } from "./path-rule-commands.ts";
import { ALL_DURATIONS, askPermission, Duration } from "./permission-prompt.ts";
import type { LastingDuration } from "./permission-prompt.ts";
import { permissionUI } from "./permission-ui.ts";
import { plansDirectory } from "./plan-file.ts";
import { PLAN_TOOLS } from "./plan-tools.ts";
import { isSandboxActive, sandboxStatus } from "./sandbox-state.ts";
import { serialize } from "./ui-queue.ts";
import { announceSessionGrantsChanged, provideSessionGrants } from "./session-grants.ts";
import type { SessionGrant } from "./session-grants.ts";
import { planToolPermission, toolDecisionGrants, trustedReadOnlyToolNames } from "./tool-permission-policy.ts";
import type { ToolPermission } from "./tool-permission-policy.ts";
import { stringProperty } from "./untyped.ts";

export interface ModeDefinition {
  identity: ModeIdentity;
  // Whether the mode's startup flag counts on this session_start; plan mode ignores its flag
  // in a fresh handoff session.
  requestedAtStartup(event: { reason: string }, context: ExtensionContext): boolean;
  // Whether the settings start this mode in a session whose branch records no mode yet.
  defaultAtStartup?(event: { reason: string }, context: ExtensionContext): boolean;
}

export interface RestrictedModeHandle {
  isActive(): boolean;
  flushPendingToggle(context: ExtensionContext): void;
  leave(context: ExtensionContext): void;
  blockedReason(toolName: string): string | undefined;
  // Handles "" (toggle), "grants", "allow <glob>" and "deny <glob>"; false for anything else.
  handleCommand(argument: string, context: ExtensionCommandContext): Promise<boolean>;
  completions(prefix: string): AutocompleteItem[] | null;
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
    completions: (prefix) => completionItems(RULE_SUBCOMMANDS, prefix),
  };
}

const DISCOVERY_CHANNEL = "config:restricted-mode:discover";
const INDICATOR_KEY = "agent-mode";
// Long enough to recognize a command or path in the permission prompt, short enough to keep the
// prompt on screen.
const MAX_INPUT_SUMMARY_LENGTH = 200;
const ELLIPSIS = "...";

const UNGATED_TOOLS = new Set([
  // File tools are gated per path by lib/path-permissions.ts rather than per call.
  ...FILE_TOOLS,
  "question",
  // Safe under a restricted mode by construction: the subagent extension caps child
  // tools at what the mode leaves ungated or granted.
  "subagent",
  // They reject themselves outside plan mode.
  ...PLAN_TOOLS,
]);

const MODE_UNGATED_TOOLS: Record<RestrictedMode, ReadonlySet<string>> = {
  [AgentMode.Planning]: UNGATED_TOOLS,
  // Reviewing with tuicr is part of exploring a change; it only opens a pane and exchanges review comments.
  [AgentMode.Exploring]: new Set([...UNGATED_TOOLS, "tuicr_open", "tuicr_wait", "tuicr_comment"]),
};

type Decision = "allow-session" | "allow-always" | "deny-session" | "deny-always";

// Once-answers are never recorded, so only the lasting durations map to a stored decision.
const ALLOW_DECISIONS = { session: "allow-session", always: "allow-always" } as const satisfies Record<LastingDuration, Decision>;
const DENY_DECISIONS = { session: "deny-session", always: "deny-always" } as const satisfies Record<LastingDuration, Decision>;

// A toggle while the agent runs waits for the next tool call or the end of the run.
type AgentActivity = { kind: "idle" } | { kind: "running"; pendingMode: AgentMode | undefined };

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
    // Only discoverEngine emits on this channel, so the data is always its request.
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
  #activity: AgentActivity = { kind: "idle" };
  readonly #registered = new Map<RestrictedMode, { pi: ExtensionAPI; definition: ModeDefinition }>();
  readonly #messages: ModeMessages;
  readonly #pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) {
    this.#pi = pi;
    initPathPermissions(pi);
    this.#messages = registerModeMessages(pi, {
      snapshot: () => this.#currentSnapshot(),
      projection: (context) => context.sessionManager.buildSessionProjection().messages,
      prepare: (context) => this.flushPendingToggle(context),
    });
    // activeStores() is empty outside the restricted modes, so execution mode shows no tool decisions.
    provideSessionGrants(pi.events, () => this.#sessionToolGrants());
    this.#wire();
  }

  // Each definition keeps the pi of its own extension because flags can only be read by the
  // extension that registered them.
  register(pi: ExtensionAPI, definition: ModeDefinition): void {
    this.#registered.set(definition.identity.mode, { pi, definition });
  }

  async handleCommand(definition: ModeDefinition, argument: string, context: ExtensionCommandContext): Promise<boolean> {
    if (!argument) {
      this.#toggle(definition.identity, context);
      return true;
    }
    if (argument === "grants") {
      await this.#manageDecisions(definition.identity, context);
      return true;
    }
    const [subcommand, ...rest] = argument.split(/\s+/);
    if (subcommand === "allow" || subcommand === "deny") {
      const { identity } = definition;
      await addPathRuleInteractively(subcommand, rest.join(" "), storeForMode(identity.mode), `/${identity.command}`, context);
      return true;
    }
    return false;
  }

  setMode(target: AgentMode, context: ExtensionContext): void {
    this.mode = target;
    setAgentMode(target);
    this.#refreshIndicators(context);
    // Every switch records each mode, so the branch always says which one is enabled.
    for (const mode of RESTRICTED_MODES) this.#persist(mode);
    this.#messages.announce(context);
    announceSessionGrantsChanged(this.#pi.events);
  }

  flushPendingToggle(context: ExtensionContext): void {
    if (this.#activity.kind !== "running" || this.#activity.pendingMode === undefined) return;

    const target = this.#activity.pendingMode;
    this.#activity = { kind: "running", pendingMode: undefined };
    if (target === this.mode) {
      this.#refreshIndicators(context);
      return;
    }
    const from = this.mode;
    this.setMode(target, context);
    context.ui.notify(transitionNotice(from, target, Timing.Immediate));
  }

  #wire(): void {
    const pi = this.#pi;

    pi.on("tool_call", async (event, context) => {
      this.flushPendingToggle(context);
      const outcome = this.#gate(event.toolName, context.hasUI ? Interaction.Available : Interaction.Unavailable);
      if (outcome.kind === "run") return;
      if (outcome.kind === "block") return { block: true, reason: outcome.reason };
      return await serialize(() => this.#requestPermission(event, context));
    });

    pi.on("agent_start", async () => {
      this.#activity = { kind: "running", pendingMode: undefined };
    });

    pi.on("agent_end", async (_event, context) => {
      this.flushPendingToggle(context);
      this.#activity = { kind: "idle" };
    });

    pi.on("session_start", async (event, context) => {
      const restored = await this.#restoreBranchState(context);
      const requested = [...this.#registered.values()]
        .filter(({ pi: owner, definition }) => owner.getFlag(definition.identity.command) === true && definition.requestedAtStartup(event, context))
        .map(({ definition }) => definition.identity.mode);
      const defaulted = [...this.#registered.values()]
        .filter(({ definition }) => definition.defaultAtStartup?.(event, context) === true)
        .map(({ definition }) => definition.identity.mode);
      if (requested.length > 1) {
        context.ui.notify("Both --plan and --explore were given; starting in plan mode.", "warning");
      }
      const { mode, recording } = startupMode(restored, requested, defaulted);
      this.mode = mode;
      if (recording === StateRecording.Record) for (const restricted of RESTRICTED_MODES) this.#persist(restricted);
      this.#applyRestoredState(context);
    });

    // The selected branch's recorded mode wins over the startup flag here: navigating is not a restart.
    pi.on("session_tree", async (_event, context) => {
      await this.#restoreBranchState(context);
      this.#applyRestoredState(context);
    });
  }

  #currentSnapshot(): ModeSnapshot {
    return {
      mode: this.mode,
      plansDirectory: plansDirectory(),
      sandbox: sandboxStatus(),
      denials: effectiveDenials(this.#activeStores()),
    };
  }

  #activeStores(): DecisionStores {
    return isRestricted(this.mode) ? this.decisions[this.mode] : emptyStores();
  }

  #sessionToolGrants(): SessionGrant[] {
    const { sessionGrants, sessionDenials } = this.#activeStores();
    return toolDecisionGrants(sessionGrants, sessionDenials.keys());
  }

  #gate(toolName: string, interaction: Interaction): ToolGate {
    return toolGate(toolName, { mode: this.mode, denials: this.#activeStores(), permission: this.#permission(toolName), interaction });
  }

  #permission(toolName: string): ToolPermission {
    // The sandbox makes bash read-only in restricted modes at the OS level; without it bash stays gated per call.
    if (toolName === "bash" && isSandboxActive()) return "allow";
    const { sessionGrants, alwaysGrants, sessionDenials, alwaysDenials } = this.#activeStores();
    return planToolPermission(
      toolName,
      { sessionGrants, alwaysGrants, sessionDenials: sessionDenials.keys(), alwaysDenials: alwaysDenials.keys() },
      isRestricted(this.mode) ? MODE_UNGATED_TOOLS[this.mode] : UNGATED_TOOLS,
      trustedReadOnlyToolNames(this.#pi.getAllTools()),
    );
  }

  async #requestPermission(event: ToolCallEvent, context: ExtensionContext): Promise<ToolCallEventResult | undefined> {
    // An earlier prompt from the same batch may have decided this tool while we queued.
    const queued = this.#gate(event.toolName, Interaction.Available);
    if (queued.kind === "block") return { block: true, reason: queued.reason };
    if (queued.kind === "run") return undefined;

    const { mode } = this;
    if (!isRestricted(mode)) return undefined;
    const answer = await askPermission(permissionUI(context.ui), {
      title: `${MODE_IDENTITIES[mode].label} — allow ${event.toolName}?\n\n  ${summarizeInput(event.input)}`,
      subject: event.toolName,
      scope: event.toolName,
      narrower: [],
      durations: ALL_DURATIONS,
    });
    if (answer.decision === "allow") {
      if (answer.duration !== Duration.Once) await this.#record(mode, event.toolName, ALLOW_DECISIONS[answer.duration], context);
      return undefined;
    }
    if (answer.duration === Duration.Once) {
      return { block: true, reason: deniedReason(mode, event.toolName, "the user denied this call", answer.note) };
    }
    const decision = DENY_DECISIONS[answer.duration];
    await this.#record(mode, event.toolName, decision, context, answer.note);
    return { block: true, reason: deniedReason(mode, event.toolName, DENIAL_CAUSES[decision], answer.note) };
  }

  // The most recent decision wins outright, so a tool never sits in two stores and
  // a narrow grant can always override an earlier "always" denial.
  async #record(mode: RestrictedMode, toolName: string, decision: Decision, context: ExtensionContext, note?: string): Promise<void> {
    const stores = this.decisions[mode];
    for (const store of storesOf(stores)) store.delete(toolName);
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
    await this.#save(mode, context);
  }

  async #save(mode: RestrictedMode, context: ExtensionContext): Promise<void> {
    this.#persist(mode);
    const { alwaysGrants, alwaysDenials } = this.decisions[mode];
    await writePersistedDecisions(mode, alwaysGrants, alwaysDenials).catch((error: unknown) => {
      context.ui.notify(`${MODE_IDENTITIES[mode].label} decision applies to this session only, it was not saved: ${errorMessage(error)}`, "error");
    });
    this.#messages.announce(context);
    announceSessionGrantsChanged(this.#pi.events);
  }

  #persist(mode: RestrictedMode): void {
    const { sessionGrants, sessionDenials } = this.decisions[mode];
    this.#pi.appendEntry(MODE_IDENTITIES[mode].entryType, {
      enabled: this.mode === mode,
      sessionGrants: [...sessionGrants],
      sessionDenials: [...sessionDenials].map(([name, note]) => ({ name, note })),
    });
  }

  #toggle(identity: ModeIdentity, context: ExtensionContext): void {
    const current = this.#pendingMode() ?? this.mode;
    const target = current === identity.mode ? AgentMode.Execution : identity.mode;
    if (this.#activity.kind === "running") {
      this.#activity = { kind: "running", pendingMode: target };
      this.#refreshIndicators(context);
      context.ui.notify(transitionNotice(current, target, Timing.Deferred));
      return;
    }
    this.setMode(target, context);
    context.ui.notify(transitionNotice(current, target, Timing.Immediate));
  }

  #pendingMode(): AgentMode | undefined {
    return this.#activity.kind === "running" ? this.#activity.pendingMode : undefined;
  }

  #refreshIndicators(context: ExtensionContext): void {
    const { theme } = context.ui;
    const pendingMode = this.#pendingMode();
    const pending = pendingMode !== this.mode ? pendingMode : undefined;
    const status = isRestricted(this.mode)
      ? theme.fg("warning", `${MODE_IDENTITIES[this.mode].statusIcon} ${MODE_IDENTITIES[this.mode].command}`)
      : undefined;
    context.ui.setStatus(INDICATOR_KEY, status);
    context.ui.setWidget(INDICATOR_KEY, modeBanner(theme, this.mode, pending), { placement: "aboveEditor" });
  }

  async #restoreBranchState(context: ExtensionContext): Promise<ActiveRestrictedMode> {
    this.#messages.reset();
    for (const mode of RESTRICTED_MODES) {
      const stores = this.decisions[mode];
      for (const store of storesOf(stores)) store.clear();

      const { alwaysAllowed, alwaysDenied } = await readPersistedDecisions(mode).catch((error: unknown) => {
        context.ui.notify(`${errorMessage(error)} ${MODE_IDENTITIES[mode].label} decisions saved with "always" were not loaded.`, "warning");
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

  #applyRestoredState(context: ExtensionContext): void {
    setAgentMode(this.mode);
    this.#refreshIndicators(context);
    announceSessionGrantsChanged(this.#pi.events);
  }

  async #manageDecisions(identity: ModeIdentity, context: ExtensionContext): Promise<void> {
    const { label, mode } = identity;
    const pathRuleStore = storeForMode(mode);
    if (!context.hasUI) {
      context.ui.notify(`Managing ${label.toLowerCase()} decisions needs an interactive UI.`, "error");
      return;
    }

    const stores = this.decisions[mode];
    await manageDecisions(
      {
        title: `${label} decisions — pick one to remove`,
        emptyMessage: `No ${label.toLowerCase()} grants, denials or path rules recorded.`,
        clearedMessage: `Cleared all ${label.toLowerCase()} grants, denials and path rules.`,
        entries: async () => listDecisions(stores, await listPathRules(pathRuleStore), pathRuleStore),
        clearAll: async () => {
          for (const store of storesOf(stores)) store.clear();
          await this.#save(mode, context);
          await clearPathRules(pathRuleStore);
        },
        removed: () => this.#save(mode, context),
      },
      context,
    );
  }
}

function emptyStores(): DecisionStores {
  return { sessionGrants: new Set(), alwaysGrants: new Set(), sessionDenials: new Map(), alwaysDenials: new Map() };
}

function storesOf(stores: DecisionStores): (Set<string> | Map<string, string | undefined>)[] {
  return [stores.sessionGrants, stores.alwaysGrants, stores.sessionDenials, stores.alwaysDenials];
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

function listDecisions(stores: DecisionStores, pathRules: readonly PathRule[], pathRuleStore: PathRuleStore): DecisionEntry[] {
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
    ...pathRuleEntries(pathRules, pathRuleStore),
  ];
}

function summarizeInput(input: object): string {
  const detail = stringProperty(input, "command") ?? stringProperty(input, "path") ?? JSON.stringify(input);
  if (detail.length <= MAX_INPUT_SUMMARY_LENGTH) return detail;
  return `${detail.slice(0, MAX_INPUT_SUMMARY_LENGTH - ELLIPSIS.length)}${ELLIPSIS}`;
}
