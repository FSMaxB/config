import { stat } from "node:fs/promises";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { FILE_TOOLS } from "./lib/file-tools.ts";
import {
  addPathRule,
  clearPathRules,
  initPathPermissions,
  listPathRules,
  removePathRule,
  restoreSessionPathRules,
  setPlanModeEnabled,
} from "./lib/path-permissions.ts";
import { normalizePathSelector } from "./lib/path-rule-normalization.ts";
import { selectorKey, selectorLabel, type AccessMode, type PathRule, type RuleKind, type RuleTier } from "./lib/path-permission-rules.ts";
import {
  latestPlanModeEntry,
  PLAN_MODE_ENTRY_TYPE,
  readPersistedDecisions,
  writePersistedDecisions,
} from "./lib/plan-decisions.ts";
import { newPlanPath, plansDirectory } from "./lib/plan-file.ts";
import { commitPlanFileForUser } from "./lib/plan-commit.ts";
import {
  latestPlanHandoffEntry,
  PLAN_HANDOFF_ENTRY_TYPE,
} from "./lib/plan-handoff.ts";
import { registerToolWithGuidelines } from "./lib/register-tool.ts";
import { serialize } from "./lib/ui-queue.ts";

const PLAN_PATH = "plan_path";
const SUBMIT_PLAN = "submit_plan";
const PLAN_TOOLS = [PLAN_PATH, SUBMIT_PLAN];
const UNGATED_TOOLS = new Set([
  // File tools are gated per path by lib/path-permissions.ts rather than per call.
  ...FILE_TOOLS,
  "question",
  // Safe under plan mode by construction: the subagent extension caps child
  // tools at what plan mode leaves ungated or granted here.
  "subagent",
  ...PLAN_TOOLS,
]);

const ALLOW_ONCE = "Allow once";
const ALLOW_SESSION = "Allow in session";
const ALLOW_ALWAYS = "Allow always";
const DENY_ONCE = "Deny once";
const DENY_SESSION = "Deny in session";
const DENY_ALWAYS = "Deny always";
const APPROVE = "Approve — leave plan mode";
const APPROVE_CURRENT = "Approve — implement with current model";
const IMPLEMENT_DIFFERENT = "Implement with different model";
const REFINE = "Refine — send feedback";
const CLEAR_ALL = "Clear all";
const DONE = "Done";
const CONTEXT_FULL = "Full context — inherit the whole conversation";
const CONTEXT_COMPACT = "Compact — summarize, then implement in a fresh turn";
const CONTEXT_FRESH = "Fresh session — only the plan file, nothing else";
const FRESH_HANDOFF_ARGUMENT = "fresh-handoff";

export default function (pi: ExtensionAPI) {
  initPathPermissions(pi);
  let planMode = false;
  let agentRunning = false;
  let pendingToggle: boolean | undefined;
  let pendingFreshHandoff: FreshHandoff | undefined;
  const sessionGrants = new Set<string>();
  const alwaysGrants = new Set<string>();
  // Denials carry the note the user left, so a repeat block can keep repeating the guidance
  // instead of only saying no.
  const sessionDenials = new Map<string, string | undefined>();
  const alwaysDenials = new Map<string, string | undefined>();

  function isAllowed(toolName: string): boolean {
    return (
      UNGATED_TOOLS.has(toolName) ||
      sessionGrants.has(toolName) ||
      alwaysGrants.has(toolName)
    );
  }

  function blockedReason(toolName: string): string | undefined {
    if (alwaysDenials.has(toolName)) {
      return deniedReason(
        toolName,
        "you denied it for all sessions",
        alwaysDenials.get(toolName),
      );
    }
    if (sessionDenials.has(toolName)) {
      return deniedReason(
        toolName,
        "you denied it for this session",
        sessionDenials.get(toolName),
      );
    }
    return undefined;
  }

  // The most recent decision wins outright, so a tool never sits in two stores and
  // a narrow grant can always override an earlier "always" denial.
  async function record(
    toolName: string,
    decision: Decision,
    note?: string,
  ): Promise<void> {
    for (const store of [
      sessionGrants,
      alwaysGrants,
      sessionDenials,
      alwaysDenials,
    ]) {
      store.delete(toolName);
    }
    switch (decision) {
      case "allow-session":
        sessionGrants.add(toolName);
        break;
      case "allow-always":
        alwaysGrants.add(toolName);
        break;
      case "deny-session":
        sessionDenials.set(toolName, note);
        break;
      case "deny-always":
        alwaysDenials.set(toolName, note);
        break;
    }
    persist();
    await writePersistedDecisions(alwaysGrants, alwaysDenials);
  }

  function persist(): void {
    pi.appendEntry(PLAN_MODE_ENTRY_TYPE, {
      enabled: planMode,
      sessionGrants: [...sessionGrants],
      sessionDenials: [...sessionDenials].map(([name, note]) => ({
        name,
        note,
      })),
    });
  }

  function refreshIndicators(ctx: ExtensionContext): void {
    const pendingChange =
      pendingToggle !== undefined && pendingToggle !== planMode;
    ctx.ui.setStatus(
      "plan-mode",
      planMode ? ctx.ui.theme.fg("warning", "⏸ plan") : undefined,
    );
    ctx.ui.setWidget(
      "plan-mode",
      planBanner(ctx.ui.theme, planMode, pendingChange),
      { placement: "aboveEditor" },
    );
  }

  // The plan tools are added and removed as a delta against the live tool list rather than
  // restored from a snapshot, so a changed extension set can never resurrect stale tools.
  function syncPlanTools(): void {
    const active = pi.getActiveTools();
    const missing = PLAN_TOOLS.filter((name) => !active.includes(name));
    if (planMode && missing.length > 0) {
      pi.setActiveTools([...active, ...missing]);
    } else if (!planMode && missing.length < PLAN_TOOLS.length) {
      pi.setActiveTools(active.filter((name) => !PLAN_TOOLS.includes(name)));
    }
  }

  function setPlanMode(enabled: boolean, ctx: ExtensionContext): void {
    planMode = enabled;
    setPlanModeEnabled(enabled);
    syncPlanTools();
    refreshIndicators(ctx);
    persist();
  }

  function toggle(ctx: ExtensionContext): void {
    if (agentRunning) {
      pendingToggle = !(pendingToggle ?? planMode);
      refreshIndicators(ctx);
      ctx.ui.notify(
        `Plan mode will be ${pendingToggle ? "enabled" : "disabled"} at the next tool call.`,
      );
      return;
    }
    setPlanMode(!planMode, ctx);
    ctx.ui.notify(planMode ? "Plan mode enabled." : "Plan mode disabled.");
  }

  function flushPendingToggle(ctx: ExtensionContext): void {
    if (pendingToggle === undefined) return;

    const enabled = pendingToggle;
    pendingToggle = undefined;
    if (enabled === planMode) {
      refreshIndicators(ctx);
      return;
    }
    setPlanMode(enabled, ctx);
    ctx.ui.notify(planMode ? "Plan mode enabled." : "Plan mode disabled.");
  }

  async function requestPermission(
    event: ToolCallEvent,
    ctx: ExtensionContext,
  ) {
    // An earlier prompt from the same batch may have decided this tool while we queued.
    const blocked = blockedReason(event.toolName);
    if (blocked) return { block: true, reason: blocked };
    if (isAllowed(event.toolName)) return undefined;

    const choice = await ctx.ui.select(
      `Plan mode — allow ${event.toolName}?\n\n  ${summarizeInput(event)}`,
      [
        ALLOW_ONCE,
        ALLOW_SESSION,
        ALLOW_ALWAYS,
        DENY_ONCE,
        DENY_SESSION,
        DENY_ALWAYS,
      ],
    );

    switch (choice) {
      case ALLOW_ONCE:
        return undefined;
      case ALLOW_SESSION:
        await record(event.toolName, "allow-session");
        return undefined;
      case ALLOW_ALWAYS:
        await record(event.toolName, "allow-always");
        return undefined;
      case DENY_SESSION: {
        const note = await askDenyNote(ctx);
        await record(event.toolName, "deny-session", note);
        return {
          block: true,
          reason: deniedReason(
            event.toolName,
            "you denied it for this session",
            note,
          ),
        };
      }
      case DENY_ALWAYS: {
        const note = await askDenyNote(ctx);
        await record(event.toolName, "deny-always", note);
        return {
          block: true,
          reason: deniedReason(
            event.toolName,
            "you denied it for all sessions",
            note,
          ),
        };
      }
      default: {
        // Also covers dismissing the prompt, which should not stop to ask for a note.
        const note = choice === DENY_ONCE ? await askDenyNote(ctx) : undefined;
        return {
          block: true,
          reason: deniedReason(
            event.toolName,
            "the user denied this call",
            note,
          ),
        };
      }
    }
  }

  async function askDenyNote(
    ctx: ExtensionContext,
  ): Promise<string | undefined> {
    const note = await ctx.ui.input(
      "What should the agent do instead?",
      "Optional — leave empty to just deny",
    );
    return note?.trim() || undefined;
  }

  async function manageDecisions(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) {
      ctx.ui.notify(
        "Managing plan mode decisions needs an interactive UI.",
        "error",
      );
      return;
    }

    while (true) {
      const entries = listDecisions(
        sessionGrants,
        alwaysGrants,
        sessionDenials,
        alwaysDenials,
        await listPathRules(),
      );
      if (entries.length === 0) {
        ctx.ui.notify("No plan mode grants, denials or path rules recorded.");
        return;
      }

      const labels = entries.map(({ label }) => label);
      const choice = await ctx.ui.select(
        "Plan mode decisions — pick one to remove",
        [...labels, CLEAR_ALL, DONE],
      );

      if (choice === CLEAR_ALL) {
        for (const store of [
          sessionGrants,
          alwaysGrants,
          sessionDenials,
          alwaysDenials,
        ]) {
          store.clear();
        }
        persist();
        await writePersistedDecisions(alwaysGrants, alwaysDenials);
        await clearPathRules();
        ctx.ui.notify("Cleared all plan mode grants, denials and path rules.");
        return;
      }

      const entry = entries[labels.indexOf(choice ?? "")];
      if (!entry) return;

      await entry.remove();
      persist();
      await writePersistedDecisions(alwaysGrants, alwaysDenials);
    }
  }

  pi.registerFlag("plan", {
    description: "Start in plan mode (tools that change things need approval)",
    type: "boolean",
    default: false,
  });

  registerToolWithGuidelines(pi, {
    name: PLAN_PATH,
    label: "Plan path",
    description:
      "Return the absolute path a new plan file should be written to, inside the plans directory for this working directory. " +
      "Only available in plan mode. It creates nothing: write the plan to the returned path with the write tool, revise it with edit, " +
      "and pass the same path to submit_plan and crit_review.",
    promptSnippet: "Get the path for a new plan file",
    promptGuidelines: [
      "Call plan_path once per plan and keep using the path it returns; do not call it again to revise the same plan.",
    ],
    parameters: Type.Object({
      slug: Type.String({
        description: "Short kebab-case name for the plan, used in the filename",
      }),
    }),

    async execute(_toolCallId, params): Promise<AgentToolResult<{ path: string | null }>> {
      if (!planMode) {
        return {
          content: [{ type: "text", text: "plan_path is only available in plan mode." }],
          details: { path: null },
        };
      }
      const path = newPlanPath(params.slug);
      return {
        content: [
          {
            type: "text",
            text: `Write the plan to ${path} with the write tool, revise it with edit, and pass this path to submit_plan.`,
          },
        ],
        details: { path },
      };
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("plan_path ")) + theme.fg("muted", args.slug ?? ""),
        0,
        0,
      );
    },

    renderResult(result, _renderOptions, theme) {
      const details = result.details as { path: string | null } | undefined;
      if (!details?.path) {
        return new Text(theme.fg("error", "✗ only available in plan mode"), 0, 0);
      }
      return new Text(theme.fg("success", "✓ ") + theme.fg("dim", details.path), 0, 0);
    },
  });

  registerToolWithGuidelines(pi, {
    name: SUBMIT_PLAN,
    label: "Submit plan",
    description:
      "Submit the plan file at path for the user to approve. Only available in plan mode. " +
      "Optionally suggest a different model to implement the plan; the user decides whether to use it. " +
      "Asks the user whether to approve it, request changes, or stay in plan mode. Approval is the only way out of plan mode. " +
      "The submitted file is committed into the plans directory's repository (jj, or git as fallback).",
    promptSnippet:
      "Submit the written plan for the user to approve, ending plan mode",
    promptGuidelines: [
      "Call submit_plan with the plan file path once the file holds the finished plan, rather than describing the plan and waiting for a reply.",
      "Only the user can leave plan mode, so never assume approval before submit_plan returns it.",
      "Suggest an implementation model via suggestedModel only when a different model is clearly better suited than the current one (for example a cheaper model for a mechanical plan); otherwise omit it.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      path: Type.String({
        description: "Absolute path of the plan file to submit, as returned by plan_path",
      }),
      suggestedModel: Type.Optional(
        Type.String({
          description:
            'Model suggested for implementing the plan, as "provider/id" (a bare id works when unambiguous). ' +
            "Omit when the current model should implement it.",
        }),
      ),
      suggestedModelReason: Type.Optional(
        Type.String({
          description:
            "One short sentence on why the suggested model fits this implementation; shown to the user.",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!planMode) {
        const error = "submit_plan is only available in plan mode.";
        return {
          content: [{ type: "text", text: error }],
          details: { path: null, outcome: "unavailable" },
        };
      }

      const { path } = params;
      const planFile = await stat(path).catch(() => undefined);
      if (!planFile?.isFile()) {
        return {
          content: [{ type: "text", text: `No plan file exists at ${path}. Write it first, then call submit_plan with its path.` }],
          details: { path: null, outcome: "missing" },
        };
      }

      if (!ctx.hasUI) {
        return {
          content: [
            {
              type: "text",
              text: `Plan at ${path} could not be submitted: no interactive UI, so plan mode stays on.`,
            },
          ],
          details: { path, outcome: "saved" },
        };
      }

      await commitPlanFileForUser(pi, ctx, path, "submit");

      const { suggestedModel, suggestedModelReason } = params;
      let suggested = suggestedModel
        ? findSuggestedModel(suggestedModel, ctx.modelRegistry.getAvailable())
        : undefined;
      if (suggestedModel && !suggested) {
        ctx.ui.notify(
          `Suggested model "${suggestedModel}" is not available.`,
          "warning",
        );
      }
      if (
        suggested &&
        ctx.model &&
        suggested.provider === ctx.model.provider &&
        suggested.id === ctx.model.id
      ) {
        // Suggesting the session model leaves nothing to offer.
        suggested = undefined;
      }

      const suggestedLabel = suggested
        ? `${suggested.provider}/${suggested.id}`
        : undefined;
      const approveSuggested = suggestedLabel
        ? `Approve — implement with ${suggestedLabel} (suggested)`
        : undefined;
      const reason = suggestedModelReason?.trim();
      const suggestionNote = suggestedLabel
        ? `\n\n  Suggests ${suggestedLabel}${reason ? ` — ${reason}` : ""}`
        : "";

      const choice = await ctx.ui.select(
        `Plan submitted — what next?\n\n  ${path}${suggestionNote}`,
        [
          ...(approveSuggested ? [approveSuggested] : []),
          suggested ? APPROVE_CURRENT : APPROVE,
          IMPLEMENT_DIFFERENT,
          REFINE,
          "Stay in plan mode",
        ],
      );

      if (suggested && choice === approveSuggested) {
        return await handOffToModel(path, suggested, undefined, ctx);
      }

      if (choice === APPROVE || choice === APPROVE_CURRENT) {
        setPlanMode(false, ctx);
        return {
          content: [
            {
              type: "text",
              text: `Plan at ${path} approved. Plan mode is off and full tool access is restored.`,
            },
          ],
          details: { path, outcome: "approved" },
        };
      }

      if (choice === IMPLEMENT_DIFFERENT) {
        return await handleImplementDifferent(path, ctx);
      }

      if (choice === REFINE) {
        const feedback = (
          await ctx.ui.input("Feedback on the plan:", "What should change?")
        )?.trim();
        const text = feedback
          ? `Plan at ${path} not approved. Still in plan mode. The user asks for: ${feedback}`
          : `Plan at ${path} not approved. Still in plan mode.`;
        return {
          content: [{ type: "text", text }],
          details: { path, outcome: "refine" },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Plan at ${path} not approved. Still in plan mode.`,
          },
        ],
        details: { path, outcome: "saved" },
      };
    },

    renderCall(args, theme) {
      const suggested = typeof args.suggestedModel === "string" && args.suggestedModel
        ? theme.fg("muted", ` suggests ${args.suggestedModel}`)
        : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("submit_plan ")) + theme.fg("muted", args.path ?? "") + suggested,
        0,
        0,
      );
    },

    renderResult(result, renderOptions, theme) {
      const details = result.details as
        | { path: string | null; outcome: string }
        | undefined;
      if (renderOptions.isPartial) {
        return new Text(
          theme.fg("muted", "Waiting for your decision..."),
          0,
          0,
        );
      }
      if (!details?.path) {
        const reason =
          details?.outcome === "missing"
            ? "plan file not found"
            : "only available in plan mode";
        return new Text(theme.fg("error", `✗ ${reason}`), 0, 0);
      }
      const label =
        details.outcome === "approved"
          ? "approved"
          : details.outcome === "refine"
            ? "needs changes"
            : details.outcome === "handed-off"
              ? "handed off"
              : "submitted";
      return new Text(
        theme.fg("success", "✓ ") +
          theme.fg("accent", label) +
          theme.fg("dim", ` — ${details.path}`),
        0,
        0,
      );
    },
  });

  async function handleImplementDifferent(
    planPath: string,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<{ path: string; outcome: string }>> {
    const models = ctx.modelRegistry.getAvailable();
    if (models.length === 0) {
      return notApproved(
        planPath,
        "No models with configured auth are available.",
      );
    }

    const currentModelLabel = ctx.model
      ? `${ctx.model.provider}/${ctx.model.id}`
      : undefined;
    const modelOptions = models.map((model) => {
      const label = `${model.provider}/${model.id}`;
      return label === currentModelLabel ? `${label} (current)` : label;
    });
    const modelChoice = await ctx.ui.select(
      "Implement with which model?",
      modelOptions,
    );
    if (modelChoice === undefined) return notApproved(planPath);
    const selectedModel = models[modelOptions.indexOf(modelChoice)];

    let level: ModelThinkingLevel = pi.getThinkingLevel();
    const supportedLevels = getSupportedThinkingLevels(selectedModel);
    if (supportedLevels.length > 1) {
      const currentLevel = level;
      const levelOptions = supportedLevels.map((candidate) =>
        candidate === currentLevel ? `${candidate} (current)` : candidate,
      );
      const levelChoice = await ctx.ui.select("Thinking level", levelOptions);
      if (levelChoice !== undefined) {
        level = supportedLevels[levelOptions.indexOf(levelChoice)];
      }
    }

    return await handOffToModel(planPath, selectedModel, level, ctx);
  }

  async function handOffToModel(
    planPath: string,
    selectedModel: Model<Api>,
    level: ModelThinkingLevel | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<{ path: string; outcome: string }>> {
    const modelName = `${selectedModel.provider}/${selectedModel.id}`;
    const choice = await ctx.ui.select(
      `How should ${modelName} start?\n\n` +
        "  Full context keeps the whole conversation, plan text included.\n" +
        "  Compact aborts this turn, summarizes, and implements from the summary plus the plan file.\n" +
        "  Fresh session abandons this conversation entirely; the new session only gets the plan file path.",
      [CONTEXT_FULL, CONTEXT_COMPACT, CONTEXT_FRESH],
    );

    if (choice === CONTEXT_FRESH) {
      pendingFreshHandoff = {
        planPath,
        provider: selectedModel.provider,
        modelId: selectedModel.id,
        thinkingLevel: level ?? pi.getThinkingLevel(),
      };
      setPlanMode(false, ctx);
      // newSession only exists on the command context, so the switch is dispatched
      // as a command; prompt() executes extension commands immediately even while
      // the agent is streaming, and the resulting teardown aborts this turn after
      // persisting it.
      pi.sendUserMessage(`/plan ${FRESH_HANDOFF_ARGUMENT}`, {
        expandPromptTemplates: true,
      });
      return {
        content: [
          {
            type: "text",
            text: `Plan at ${planPath} approved. A fresh session with ${modelName} takes over; this conversation ends here.`,
          },
        ],
        details: { path: planPath, outcome: "handed-off" },
      };
    }

    const compactFirst = choice === CONTEXT_COMPACT;

    if (!(await pi.setModel(selectedModel))) {
      ctx.ui.notify(`No API key for ${selectedModel.provider}.`, "error");
      return notApproved(
        planPath,
        `No API key is configured for ${selectedModel.provider}.`,
      );
    }
    // setModel re-clamps the current thinking level for the new model, so an
    // explicit choice has to be applied after the switch; without one the
    // clamped level stands.
    if (level !== undefined) pi.setThinkingLevel(level);

    setPlanMode(false, ctx);

    if (compactFirst) {
      // Compaction aborts the run this tool call belongs to, so the kickoff has
      // to come from the completion callback instead of this tool result.
      const kickoff = () =>
        pi.sendUserMessage(`Implement the plan at ${planPath}.`);
      ctx.compact({
        onComplete: kickoff,
        onError: (error) => {
          ctx.ui.notify(`Compaction failed: ${error.message}`, "error");
          kickoff();
        },
      });
      return {
        content: [
          {
            type: "text",
            text: `Plan at ${planPath} approved. Compacting the conversation, then ${modelName} implements it in a fresh turn.`,
          },
        ],
        details: { path: planPath, outcome: "handed-off" },
      };
    }

    return {
      content: [
        {
          type: "text",
          text:
            `Plan at ${planPath} approved. Plan mode is off and full tool access is restored. ` +
            `The user picked ${modelName} (thinking level ${pi.getThinkingLevel()}) to implement the plan. Implement it now.`,
        },
      ],
      details: { path: planPath, outcome: "handed-off" },
    };
  }

  pi.registerCommand("plan", {
    description:
      "Toggle plan mode, review decisions with `grants`, or add a path rule with `allow <glob>` / `deny <glob>`",
    getArgumentCompletions: (prefix) => {
      const completions = ["grants", "allow", "deny"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
      return completions.length > 0 ? completions : null;
    },
    handler: async (args, ctx) => {
      const argument = args.trim();
      if (!argument) {
        toggle(ctx);
        return;
      }
      if (argument === "grants") {
        await manageDecisions(ctx);
        return;
      }
      const [subcommand, ...rest] = argument.split(/\s+/);
      if (subcommand === "allow" || subcommand === "deny") {
        await addPathRuleInteractively(subcommand, rest.join(" "), ctx);
        return;
      }
      if (argument === FRESH_HANDOFF_ARGUMENT) {
        await startFreshHandoffSession(ctx);
        return;
      }
      ctx.ui.notify(
        `Unknown argument "${argument}". Use /plan to toggle, /plan grants to review, or /plan allow|deny <glob> to add a path rule.`,
        "error",
      );
    },
  });

  async function startFreshHandoffSession(
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    const handoff = pendingFreshHandoff;
    pendingFreshHandoff = undefined;
    if (!handoff) {
      ctx.ui.notify("No fresh-session handoff is pending.", "error");
      return;
    }

    const { cancelled } = await ctx.newSession({
      parentSession: ctx.sessionManager.getSessionFile(),
      // setup runs before session_start fires in the new runtime, so the new
      // plan-mode instance finds this entry when it initializes.
      setup: async (sessionManager) => {
        sessionManager.appendCustomEntry(PLAN_HANDOFF_ENTRY_TYPE, handoff);
      },
    });
    if (cancelled) {
      ctx.ui.notify(
        "Fresh session was cancelled — still in the current session. Ask the agent to implement the plan here instead.",
        "warning",
      );
    }
  }

  pi.on("tool_call", async (event, ctx) => {
    flushPendingToggle(ctx);
    if (!planMode) return;

    const blocked = blockedReason(event.toolName);
    if (blocked) return { block: true, reason: blocked };
    if (isAllowed(event.toolName)) return;

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: deniedReason(
          event.toolName,
          "there is no interactive UI to ask for approval",
        ),
      };
    }
    return await serialize(() => requestPermission(event, ctx));
  });

  pi.on("before_agent_start", async (event) => {
    if (!planMode) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${planModeInstructions()}`,
    };
  });

  pi.on("agent_start", async () => {
    agentRunning = true;
  });

  pi.on("agent_end", async (_event, ctx) => {
    agentRunning = false;
    flushPendingToggle(ctx);
  });

  pi.on("session_start", async (event, ctx) => {
    const { alwaysAllowed, alwaysDenied } = await readPersistedDecisions();
    for (const toolName of alwaysAllowed) {
      alwaysGrants.add(toolName);
    }
    for (const { name, note } of alwaysDenied) {
      alwaysDenials.set(name, note);
    }

    const restored = latestPlanModeEntry(ctx.sessionManager);
    if (restored) {
      planMode = restored.enabled;
      for (const toolName of restored.sessionGrants) {
        sessionGrants.add(toolName);
      }
      for (const { name, note } of restored.sessionDenials) {
        sessionDenials.set(name, note);
      }
    }
    const handoff =
      event.reason === "new"
        ? latestPlanHandoffEntry(ctx.sessionManager)
        : undefined;
    if (pi.getFlag("plan") === true && !handoff) {
      planMode = true;
    }
    setPlanModeEnabled(planMode);
    restoreSessionPathRules(ctx.sessionManager);

    syncPlanTools();
    refreshIndicators(ctx);

    if (!handoff) return;
    const model = ctx.modelRegistry
      .getAvailable()
      .find(
        (candidate) =>
          candidate.provider === handoff.provider &&
          candidate.id === handoff.modelId,
      );
    if (!model || !(await pi.setModel(model))) {
      ctx.ui.notify(
        `Plan handoff: ${handoff.provider}/${handoff.modelId} is not available. ` +
          `Pick a model, then ask it to implement the plan at ${handoff.planPath}.`,
        "error",
      );
      return;
    }
    const supportedLevels: string[] = getSupportedThinkingLevels(model);
    if (supportedLevels.includes(handoff.thinkingLevel)) {
      pi.setThinkingLevel(handoff.thinkingLevel as ModelThinkingLevel);
    }
    // session_start is emitted while the host is still rebinding the new session,
    // so the kickoff turn is deferred to the next tick instead of starting inside
    // the emit.
    setTimeout(
      () => pi.sendUserMessage(`Implement the plan at ${handoff.planPath}.`),
      0,
    );
  });
}

interface FreshHandoff {
  planPath: string;
  provider: string;
  modelId: string;
  thinkingLevel: string;
}

type Decision =
  | "allow-session"
  | "allow-always"
  | "deny-session"
  | "deny-always";

interface DecisionEntry {
  label: string;
  toolName: string;
  remove: () => void | Promise<void>;
}

function planBanner(
  theme: Theme,
  planMode: boolean,
  pendingChange: boolean,
): string[] | undefined {
  if (!planMode) {
    return pendingChange
      ? [theme.fg("dim", "⏸ plan mode starts at the next tool call")]
      : undefined;
  }

  const label = theme.fg("warning", theme.bold("⏸ PLAN MODE"));
  const hint = pendingChange
    ? " — ending at the next tool call"
    : " — read-only tools run freely, everything else asks. /plan to exit";
  return [label + theme.fg("dim", hint)];
}

function listDecisions(
  sessionGrants: Set<string>,
  alwaysGrants: Set<string>,
  sessionDenials: Map<string, string | undefined>,
  alwaysDenials: Map<string, string | undefined>,
  pathRules: PathRule[],
): DecisionEntry[] {
  const grants: [Set<string>, string][] = [
    [sessionGrants, "allow (session)"],
    [alwaysGrants, "allow (always)"],
  ];
  const denials: [Map<string, string | undefined>, string][] = [
    [sessionDenials, "deny (session)"],
    [alwaysDenials, "deny (always)"],
  ];

  return [
    ...grants.flatMap(([store, scope]) =>
      [...store].sort().map((toolName) => ({
        label: `${toolName} — ${scope}`,
        toolName,
        remove: () => void store.delete(toolName),
      })),
    ),
    ...denials.flatMap(([store, scope]) =>
      [...store.keys()].sort().map((toolName) => {
        const note = store.get(toolName);
        return {
          label: note
            ? `${toolName} — ${scope}: ${note}`
            : `${toolName} — ${scope}`,
          toolName,
          remove: () => void store.delete(toolName),
        };
      }),
    ),
    ...pathRules.map((rule) => ({
      label: `${rule.mode} ${rule.kind} ${selectorLabel(rule.selector!)} — path (${rule.tier})`,
      toolName: selectorKey(rule.selector!),
      remove: () => removePathRule(rule),
    })),
  ];
}

async function addPathRuleInteractively(
  kind: RuleKind,
  pattern: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!pattern) {
    ctx.ui.notify(`Usage: /plan ${kind} <path-or-glob>`, "error");
    return;
  }
  if (!ctx.hasUI) {
    ctx.ui.notify("Adding path rules needs an interactive UI.", "error");
    return;
  }
  const modeChoice = await ctx.ui.select(`${kind} ${pattern} for which access?`, ["read", "write", "read and write"]);
  if (modeChoice === undefined) return;
  const tierChoice = await ctx.ui.select("For how long?", ["This session", "Always"]);
  if (tierChoice === undefined) return;
  const tier: RuleTier = tierChoice === "Always" ? "always" : "session";
  const selector = await normalizePathSelector(pattern, ctx.cwd);
  const modes: AccessMode[] = modeChoice === "read and write" ? ["read", "write"] : [modeChoice as AccessMode];
  for (const mode of modes) await addPathRule({ mode, kind, tier, selector });
  ctx.ui.notify(`Path rule added: ${kind} ${modes.join("+")} ${selectorLabel(selector)} (${tier}).`);
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

function deniedReason(toolName: string, cause: string, note?: string): string {
  const reason =
    `Plan mode is active and ${cause}, so ${toolName} did not run. ` +
    "Do not retry it.";
  return note
    ? `${reason} Do this instead: ${note}`
    : `${reason} State what you need it for so the user can grant access, or call submit_plan if the plan is ready.`;
}

function planModeInstructions(): string {
  return [
    "Plan mode is active.",
    "",
    `- The file tools (${FILE_TOOLS.join(", ")}) check every path against the read/write path rules. Reading anywhere in the repository and in the memory, skill, plan and crit directories works without asking.`,
    `- Plan mode is read-only by default: writing inside the repository prompts the user for each path. The memory directory and the plans directory (${plansDirectory()}) stay writable.`,
    "- bash and every other tool that changes things need the user's approval for each call.",
    "- If a call or a path is denied, do not retry it and do not route around it.",
    `- To write a plan, call ${PLAN_PATH} once to get a file path, create the file there with write, and revise it with edit. Call ${SUBMIT_PLAN} with that path when it is ready. Only the user can leave plan mode.`,
  ].join("\n");
}

function findSuggestedModel(
  requested: string,
  availableModels: Model<Api>[],
): Model<Api> | undefined {
  const exact = availableModels.filter(
    (model) => `${model.provider}/${model.id}` === requested,
  );
  const matches =
    exact.length > 0
      ? exact
      : availableModels.filter((model) => model.id === requested);
  return matches.length === 1 ? matches[0] : undefined;
}

function notApproved(
  planPath: string,
  reason?: string,
): AgentToolResult<{ path: string; outcome: string }> {
  const text = reason
    ? `Plan at ${planPath} not approved. Still in plan mode. ${reason}`
    : `Plan at ${planPath} not approved. Still in plan mode.`;
  return {
    content: [{ type: "text", text }],
    details: { path: planPath, outcome: "saved" },
  };
}
