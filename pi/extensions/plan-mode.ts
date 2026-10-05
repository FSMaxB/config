import { stat } from "node:fs/promises";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
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
import { AgentMode } from "./lib/agent-mode.ts";
import { FILE_TOOLS } from "./lib/file-tools.ts";
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
} from "./lib/path-permissions.ts";
import { selectorLabel, type AccessMode, type PathRule, type RuleKind, type RuleTier } from "./lib/path-permission-rules.ts";
import {
  latestPlanModeEntry,
  PLAN_MODE_ENTRY_TYPE,
  readPersistedDecisions,
  writePersistedDecisions,
  type PlanModeEntry,
} from "./lib/plan-decisions.ts";
import { newPlanPath, plansDirectory } from "./lib/plan-file.ts";
import {
  activateMissingPlanTools,
  PLAN_PATH,
  PLAN_TOOLS,
  PlanModeState,
  registerPlanModeMessages,
  SandboxStatus,
  SUBMIT_PLAN,
  type PlanModeSnapshot,
} from "./lib/plan-mode-messages.ts";
import {
  blockedReason,
  DENIAL_CAUSES,
  deniedReason,
  effectiveDenials,
  Interaction,
  startupPlanMode,
  StartupRequest,
  StateRecording,
  SubmissionAction,
  submissionAction,
  submissionOptions,
  toolGate,
} from "./lib/plan-mode-policy.ts";
import { commitPlanFileForUser } from "./lib/plan-commit.ts";
import { registerPlanSubmission, type PlanSubmissionParams, type PlanSubmissionResult } from "./lib/plan-submission.ts";
import { registerToolWithGuidelines } from "./lib/register-tool.ts";
import { isSandboxActive } from "./lib/sandbox-state.ts";
import { selectWithDefault } from "./lib/select-with-default.ts";
import { latestCustomData } from "./lib/session-entries.ts";
import { serialize } from "./lib/ui-queue.ts";
import { planToolPermission, trustedReadOnlyToolNames, type ToolPermission } from "./lib/tool-permission-policy.ts";

const UNGATED_TOOLS = new Set([
  // File tools are gated per path by lib/path-permissions.ts rather than per call.
  ...FILE_TOOLS,
  "question",
  // Safe under plan mode by construction: the subagent extension caps child
  // tools at what plan mode leaves ungated or granted here.
  "subagent",
  // Creates only the session scratch directory, which the path rules allow in plan mode.
  "temp_dir",
  ...PLAN_TOOLS,
]);

const CLEAR_ALL = "Clear all";
const DONE = "Done";
const CONTEXT_FULL = "Full context — inherit the whole conversation";
const CONTEXT_COMPACT = "Compact — summarize, then implement in a fresh turn";
const CONTEXT_FRESH = "Fresh session — only the plan file, nothing else";
const FRESH_HANDOFF_ARGUMENT = "fresh-handoff";
const PLAN_HANDOFF_ENTRY_TYPE = "plan-handoff";

export default function (pi: ExtensionAPI) {
  initPathPermissions(pi);
  let planMode = false;
  let agentRunning = false;
  let pendingToggle: boolean | undefined;
  let pendingFreshHandoff: PlanHandoff | undefined;
  const sessionGrants = new Set<string>();
  const alwaysGrants = new Set<string>();
  // Denials carry the note the user left, so a repeat block can keep repeating the guidance
  // instead of only saying no.
  const sessionDenials = new Map<string, string | undefined>();
  const alwaysDenials = new Map<string, string | undefined>();
  const denials = { sessionDenials, alwaysDenials };
  const messages = registerPlanModeMessages(pi, {
    snapshot: currentSnapshot,
    projection: (context) => context.sessionManager.buildSessionProjection().messages,
    prepare: flushPendingToggle,
  });

  function currentSnapshot(): PlanModeSnapshot {
    return {
      mode: currentMode(),
      plansDirectory: plansDirectory(),
      sandbox: isSandboxActive() ? SandboxStatus.Active : SandboxStatus.Inactive,
      denials: effectiveDenials(denials),
    };
  }

  function currentMode(): PlanModeState {
    return planMode ? PlanModeState.Planning : PlanModeState.Execution;
  }

  function gate(toolName: string, interaction: Interaction) {
    return toolGate(toolName, { mode: currentMode(), denials, permission: permission(toolName), interaction });
  }

  function permission(toolName: string): ToolPermission {
    // The sandbox makes bash read-only in plan mode at the OS level; without it bash stays gated per call.
    if (toolName === "bash" && isSandboxActive()) return "allow";
    return planToolPermission(
      toolName,
      { sessionGrants, alwaysGrants, sessionDenials: sessionDenials.keys(), alwaysDenials: alwaysDenials.keys() },
      UNGATED_TOOLS,
      trustedReadOnlyToolNames(pi.getAllTools()),
    );
  }

  // The most recent decision wins outright, so a tool never sits in two stores and
  // a narrow grant can always override an earlier "always" denial.
  async function record(
    toolName: string,
    decision: Decision,
    ctx: ExtensionContext,
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
    await save(ctx);
  }

  async function save(ctx: ExtensionContext): Promise<void> {
    persist();
    await writePersistedDecisions(alwaysGrants, alwaysDenials);
    messages.announce(ctx);
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

  function setPlanMode(enabled: boolean, ctx: ExtensionContext): void {
    planMode = enabled;
    setAgentMode(enabled ? AgentMode.Planning : AgentMode.Execution);
    refreshIndicators(ctx);
    persist();
    messages.announce(ctx);
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
    const queued = gate(event.toolName, Interaction.Available);
    if (queued.kind === "block") return { block: true, reason: queued.reason };
    if (queued.kind === "run") return undefined;

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

    if (choice === ALLOW_ONCE) return undefined;
    const decision = choice === undefined ? undefined : CHOICE_DECISIONS[choice];
    if (decision === "allow-session" || decision === "allow-always") {
      await record(event.toolName, decision, ctx);
      return undefined;
    }

    // Dismissing the prompt denies the call without stopping to ask for a note.
    const note = choice === undefined ? undefined : await askDenyNote(ctx);
    if (decision) await record(event.toolName, decision, ctx, note);
    const cause = decision ? DENIAL_CAUSES[decision] : "the user denied this call";
    return { block: true, reason: deniedReason(event.toolName, cause, note) };
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
        await save(ctx);
        await clearPathRules();
        ctx.ui.notify("Cleared all plan mode grants, denials and path rules.");
        return;
      }

      const entry = entries[labels.indexOf(choice ?? "")];
      if (!entry) return;

      await entry.remove();
      await save(ctx);
    }
  }

  pi.registerFlag("plan", {
    description: "Start in plan mode (tools that change things need approval)",
    type: "boolean",
    default: false,
  });

  registerToolWithGuidelines(pi, {
    name: PLAN_PATH,
    namespace: PLANNING_NAMESPACE,
    label: "Plan path",
    description:
      "Return the absolute path a new plan file should be written to, inside the plans directory for this working directory. " +
      "Runs only while plan mode is active; otherwise the call is rejected. It creates nothing: write the plan to the returned path with the write tool, revise it with edit, " +
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

    async execute(_toolCallId, params, _signal, _onUpdate, context): Promise<AgentToolResult<{ path: string | null }>> {
      flushPendingToggle(context);
      if (!planMode) {
        return {
          content: [{ type: "text", text: "plan_path is only available in plan mode, which is off. Only the user can enable it." }],
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
    exposure: "model-only",
    namespace: PLANNING_NAMESPACE,
    label: "Submit plan",
    description:
      "Submit the plan file at path for the user to approve. Runs only while plan mode is active; otherwise the call is rejected. " +
      "Optionally suggest a different model to implement the plan; the user decides whether to use it. " +
      "Asks the user whether to approve it, request changes, or stay in plan mode. Approval ends plan mode. " +
      "The submitted file is committed into the plans directory's repository (jj, or git as fallback).",
    promptSnippet:
      "Submit the written plan for the user to approve; approval ends plan mode",
    promptGuidelines: [
      "Call submit_plan with the finished plan file path unless crit_review already submitted it automatically after explicit approval. Do not submit the same approved review a second time.",
      "Only the user can leave plan mode. Rely on the implementation decision returned by submit_plan or by automatic submission inside crit_review, not on Crit approval alone.",
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

    async execute(_toolCallId, params, signal, _onUpdate, context) {
      return await submitPlan(params, signal, context);
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
      const label = OUTCOME_LABELS[details.outcome] ?? "submitted";
      return new Text(
        theme.fg("success", "✓ ") +
          theme.fg("accent", label) +
          theme.fg("dim", ` — ${details.path}`),
        0,
        0,
      );
    },
  });

  registerPlanSubmission(pi.events, {
    available(context) {
      flushPendingToggle(context);
      return planMode;
    },
    async submit(params, signal, context) {
      signal?.throwIfAborted();
      flushPendingToggle(context);
      if (planMode && !pi.getActiveTools().includes(SUBMIT_PLAN)) {
        throw new Error("submit_plan is deactivated, so the reviewed plan was not submitted.");
      }
      return await submitPlan(params, signal, context);
    },
  });

  async function submitPlan(
    params: PlanSubmissionParams,
    signal: AbortSignal | undefined,
    context: ExtensionContext,
  ): Promise<PlanSubmissionResult> {
    signal?.throwIfAborted();
    flushPendingToggle(context);
    if (!planMode) {
      const error = "submit_plan is only available in plan mode, which is off. Only the user can enable it.";
      return {
        content: [{ type: "text", text: error }],
        details: { path: null, outcome: "unavailable" },
      };
    }

    const blocked = blockedReason(SUBMIT_PLAN, denials);
    if (blocked) throw new Error(blocked);

    const { path } = params;
    const planFile = await stat(path).catch(() => undefined);
    signal?.throwIfAborted();
    if (!planFile?.isFile()) {
      return {
        content: [{ type: "text", text: `No plan file exists at ${path}. Write it first, then call submit_plan with its path.` }],
        details: { path: null, outcome: "missing" },
      };
    }

    if (!context.hasUI) {
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

    await commitPlanFileForUser(pi, context, path, "submit");

    const { suggestedModel, suggestedModelReason } = params;
    let suggested = suggestedModel
      ? findSuggestedModel(suggestedModel, await settledAvailableModels(context))
      : undefined;
    if (suggestedModel && !suggested) {
      context.ui.notify(
        `Suggested model "${suggestedModel}" is not available.`,
        "warning",
      );
    }
    if (
      suggested &&
      context.model &&
      suggested.provider === context.model.provider &&
      suggested.id === context.model.id
    ) {
      // Suggesting the session model leaves nothing to offer.
      suggested = undefined;
    }

    const suggestedLabel = suggested
      ? `${suggested.provider}/${suggested.id}`
      : undefined;
    const reason = suggestedModelReason?.trim();
    const suggestionNote = suggestedLabel
      ? `\n\n  Suggests ${suggestedLabel}${reason ? ` — ${reason}` : ""}`
      : "";

    signal?.throwIfAborted();
    const choice = await context.ui.select(
      `Plan submitted — what next?\n\n  ${path}${suggestionNote}`,
      submissionOptions(suggestedLabel),
    );
    const action = submissionAction(choice, suggestedLabel);

    if (suggested && action === SubmissionAction.ApproveSuggested) {
      return await handOffToModel(path, suggested, undefined, context);
    }

    if (action === SubmissionAction.Approve) {
      setPlanMode(false, context);
      return {
        content: [
          {
            type: "text",
            text: `Plan at ${path} approved. Plan mode is off; ordinary tool permissions still apply.`,
          },
        ],
        details: { path, outcome: "approved" },
      };
    }

    if (action === SubmissionAction.ImplementDifferent) {
      return await handleImplementDifferent(path, context);
    }

    if (action === SubmissionAction.Refine) {
      const feedback = (
        await context.ui.input("Feedback on the plan:", "What should change?")
      )?.trim();
      return {
        ...notApproved(path, feedback && `The user asks for: ${feedback}`),
        details: { path, outcome: "refine" },
      };
    }

    return notApproved(path);
  }

  async function handleImplementDifferent(
    planPath: string,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<{ path: string; outcome: string }>> {
    const models = await settledAvailableModels(ctx);
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

    // The session level may not exist on the target model, so the preselected
    // entry is the clamped level; the "(current)" marker still tags the real one.
    const currentLevel = pi.getThinkingLevel();
    let level = clampThinkingLevel(selectedModel, currentLevel);
    const supportedLevels = getSupportedThinkingLevels(selectedModel);
    if (supportedLevels.length > 1) {
      const levelOptions = supportedLevels.map((candidate) =>
        candidate === currentLevel ? `${candidate} (current)` : candidate,
      );
      const levelChoice = await selectWithDefault(
        ctx.ui,
        "Thinking level",
        levelOptions,
        levelOptions[supportedLevels.indexOf(level)],
      );
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
    const choice = await selectWithDefault(
      ctx.ui,
      `How should ${modelName} start?\n\n` +
        "  Full context keeps the whole conversation, plan text included.\n" +
        "  Compact aborts this turn, summarizes, and implements from the summary plus the plan file.\n" +
        "  Fresh session abandons this conversation entirely; the new session only gets the plan file path.",
      [CONTEXT_FULL, CONTEXT_COMPACT, CONTEXT_FRESH],
      CONTEXT_FRESH,
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
            `Plan at ${planPath} approved. Plan mode is off; ordinary tool permissions still apply. ` +
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
    const outcome = gate(event.toolName, ctx.hasUI ? Interaction.Available : Interaction.Unavailable);
    if (outcome.kind === "run") return;
    if (outcome.kind === "block") return { block: true, reason: outcome.reason };
    return await serialize(() => requestPermission(event, ctx));
  });

  pi.on("agent_start", async () => {
    agentRunning = true;
  });

  pi.on("agent_end", async (_event, ctx) => {
    agentRunning = false;
    flushPendingToggle(ctx);
  });

  pi.on("session_start", async (event, ctx) => {
    const restored = await restoreBranchState(ctx);
    const handoff =
      event.reason === "new"
        ? latestPlanHandoff(ctx.sessionManager)
        : undefined;
    const request = handoff
      ? StartupRequest.Handoff
      : pi.getFlag("plan") === true
        ? StartupRequest.Plan
        : StartupRequest.None;
    const { enabled, recording } = startupPlanMode(restored, request);
    planMode = enabled;
    if (recording === StateRecording.Record) persist();
    applyRestoredState(ctx);

    if (!handoff) return;
    // The new runtime's availability snapshot is still being computed while
    // session_start runs (an extension's provider is registered synchronously,
    // but its auth check lands in a later async pass), so getAvailable() may not
    // list the handoff model yet. find() reads the registered providers directly;
    // setModel does its own live auth check, so availability is still enforced.
    const model = ctx.modelRegistry.find(handoff.provider, handoff.modelId);
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

  // The selected branch's recorded mode wins over the startup flag here: navigating is not a restart.
  pi.on("session_tree", async (_event, ctx) => {
    await restoreBranchState(ctx);
    applyRestoredState(ctx);
  });

  async function restoreBranchState(ctx: ExtensionContext): Promise<PlanModeEntry | undefined> {
    messages.reset();
    for (const store of [
      sessionGrants,
      alwaysGrants,
      sessionDenials,
      alwaysDenials,
    ]) {
      store.clear();
    }

    const { alwaysAllowed, alwaysDenied } = await readPersistedDecisions();
    for (const toolName of alwaysAllowed) {
      alwaysGrants.add(toolName);
    }
    for (const { name, note } of alwaysDenied) {
      alwaysDenials.set(name, note);
    }

    const restored = latestPlanModeEntry(ctx.sessionManager);
    planMode = restored?.enabled ?? false;
    for (const toolName of restored?.sessionGrants ?? []) {
      sessionGrants.add(toolName);
    }
    for (const { name, note } of restored?.sessionDenials ?? []) {
      sessionDenials.set(name, note);
    }
    restoreSessionPathRules({ getEntries: () => ctx.sessionManager.getBranch() });
    return restored;
  }

  function applyRestoredState(ctx: ExtensionContext): void {
    setAgentMode(planMode ? AgentMode.Planning : AgentMode.Execution);
    // A compatibility migration for loadouts saved without the planning tools, not a mode change.
    activateMissingPlanTools(pi);
    refreshIndicators(ctx);
  }
}

const PLANNING_NAMESPACE = { name: "planning", description: "Create plan paths and submit plans for human approval." };

interface PlanHandoff {
  planPath: string;
  provider: string;
  modelId: string;
  thinkingLevel: string;
}

// A fresh implementation session is seeded with this entry before session_start fires,
// so the new plan-mode instance knows which model to activate and which plan to kick off.
function latestPlanHandoff(
  sessionManager: { getEntries(): readonly unknown[] },
): PlanHandoff | undefined {
  const { planPath, provider, modelId, thinkingLevel } =
    latestCustomData(sessionManager, PLAN_HANDOFF_ENTRY_TYPE) ?? {};
  if (
    typeof planPath !== "string" ||
    typeof provider !== "string" ||
    typeof modelId !== "string" ||
    typeof thinkingLevel !== "string"
  ) {
    return undefined;
  }
  return { planPath, provider, modelId, thinkingLevel };
}

type Decision =
  | "allow-session"
  | "allow-always"
  | "deny-session"
  | "deny-always";

const CHOICE_DECISIONS: Record<string, Decision | undefined> = {
  [ALLOW_SESSION]: "allow-session",
  [ALLOW_ALWAYS]: "allow-always",
  [DENY_SESSION]: "deny-session",
  [DENY_ALWAYS]: "deny-always",
};

const OUTCOME_LABELS: Record<string, string | undefined> = {
  approved: "approved",
  refine: "needs changes",
  "handed-off": "handed off",
};

interface DecisionEntry {
  label: string;
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
          remove: () => void store.delete(toolName),
        };
      }),
    ),
    ...pathRules.map((rule) => ({
      label: `${rule.mode} ${rule.kind} ${selectorLabel(rule.selector)} — path (${rule.tier})`,
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

// getAvailable() is a snapshot that an in-flight availability pass has not
// necessarily updated yet (extension providers registered on this session's
// start land in a later async pass). Refreshing first is pi's documented way to
// settle the snapshot before a synchronous read; a failed refresh just leaves
// the snapshot as it was.
async function settledAvailableModels(ctx: ExtensionContext): Promise<Model<Api>[]> {
  await ctx.modelRegistry.refresh({ allowNetwork: false }).catch(() => undefined);
  return ctx.modelRegistry.getAvailable();
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
