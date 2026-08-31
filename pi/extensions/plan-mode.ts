import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
import { createEditToolDefinition, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type {
  EditToolDetails,
  EditToolInput,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  latestPlanModeEntry,
  PLAN_MODE_ENTRY_TYPE,
  readPersistedDecisions,
  writePersistedDecisions,
} from "./lib/plan-decisions.ts";
import {
  getCurrentPlanPath,
  planFileName,
  plansDirectory,
  setCurrentPlanPath,
} from "./lib/plan-file.ts";
import {
  latestPlanHandoffEntry,
  PLAN_HANDOFF_ENTRY_TYPE,
} from "./lib/plan-handoff.ts";
import { registerToolWithGuidelines } from "./lib/register-tool.ts";
import { renameRenderedTitle } from "./lib/tool-title.ts";
import { serialize } from "./lib/ui-queue.ts";

const WRITE_PLAN = "write_plan";
const EDIT_PLAN = "edit_plan";
const SUBMIT_PLAN = "submit_plan";
const PLAN_TOOLS = [WRITE_PLAN, EDIT_PLAN, SUBMIT_PLAN];
const UNGATED_TOOLS = new Set([
  "repo_read",
  "repo_grep",
  "repo_find",
  "repo_ls",
  "memory_read",
  "memory_ls",
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

const COLLAPSED_PLAN_LINES = 15;

export default function (pi: ExtensionAPI) {
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
  const planFileEditTool = createEditToolDefinition(process.cwd());
  const renderPlanEditCall = renameRenderedTitle(planFileEditTool, EDIT_PLAN);

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
      planPath: getCurrentPlanPath(),
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
    // Leaving plan mode retires the plan file so the next plan starts a fresh one instead
    // of overwriting an approved plan.
    if (!enabled) setCurrentPlanPath(undefined);
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
      );
      if (entries.length === 0) {
        ctx.ui.notify("No plan mode grants or denials recorded.");
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
        ctx.ui.notify("Cleared all plan mode grants and denials.");
        return;
      }

      const entry = entries[labels.indexOf(choice ?? "")];
      if (!entry) return;

      entry.remove();
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
    name: WRITE_PLAN,
    label: "Write plan",
    description:
      "Write or update the plan for the current plan-mode session. Only available in plan mode. " +
      "The first call creates the plan file, and every later call overwrites that same file, so pass the plan in full each time. " +
      "No other plan file can be touched. Call submit_plan once the plan is ready for the user to approve. " +
      "For small revisions to an existing plan, prefer edit_plan instead of rewriting the whole plan here.",
    promptSnippet:
      "Write or update the plan file for the current plan-mode session",
    promptGuidelines: [
      "Write the plan with write_plan before calling submit_plan, and rewrite it in full after addressing review feedback.",
    ],
    parameters: Type.Object({
      title: Type.String({
        description:
          "Short title for the plan, used for the filename on the first call",
      }),
      plan: Type.String({ description: "The full plan, as markdown" }),
    }),

    async execute(
      _toolCallId,
      params,
    ): Promise<AgentToolResult<{ path: string | null; created: boolean }>> {
      const { title, plan } = params;
      if (!planMode) {
        const error = "write_plan is only available in plan mode.";
        return {
          content: [{ type: "text", text: error }],
          details: { path: null, created: false },
        };
      }

      const created = getCurrentPlanPath() === undefined;
      const path = await writePlanFile(title, plan);
      persist();

      const text = created
        ? `Plan written to ${path}. Call write_plan again to revise it, or submit_plan once it is ready.`
        : `Plan at ${path} updated.`;
      return { content: [{ type: "text", text }], details: { path, created } };
    },

    renderCall(args, theme, context) {
      const title = new Text(
        theme.fg("toolTitle", theme.bold("write_plan ")) +
          theme.fg("muted", args.title ?? ""),
        0,
        0,
      );
      const plan = typeof args.plan === "string" ? args.plan.trim() : "";
      if (!context.argsComplete || !plan) return title;

      const lines = plan.split("\n");
      const visible = context.expanded
        ? lines
        : lines.slice(0, COLLAPSED_PLAN_LINES);

      const container = new Container();
      container.addChild(title);
      container.addChild(
        new Markdown(visible.join("\n"), 2, 0, getMarkdownTheme()),
      );
      if (visible.length < lines.length) {
        const hint = `… ${lines.length - visible.length} more lines (expand to see all)`;
        container.addChild(new Text(theme.fg("dim", hint), 2, 0));
      }
      return container;
    },

    renderResult(result, _renderOptions, theme) {
      const details = result.details as
        | { path: string | null; created: boolean }
        | undefined;
      if (!details?.path) {
        return new Text(
          theme.fg("error", "✗ only available in plan mode"),
          0,
          0,
        );
      }
      const label = details.created ? "created" : "updated";
      return new Text(
        theme.fg("success", "✓ ") +
          theme.fg("accent", label) +
          theme.fg("dim", ` — ${details.path}`),
        0,
        0,
      );
    },
  });

  registerToolWithGuidelines(pi, {
    ...planFileEditTool,
    name: EDIT_PLAN,
    label: "Edit plan",
    description:
      "Apply targeted text replacements to the current plan file, like the edit tool. Only available in plan mode, " +
      "and only after write_plan has created a plan. Each edits[].oldText must be unique in the current plan " +
      "content; edits must not overlap. Prefer this over write_plan for small revisions — it costs far fewer " +
      "output tokens than rewriting the whole plan.",
    promptSnippet: "Apply targeted text replacements to the current plan file",
    promptGuidelines: [
      "Use edit_plan for small, targeted revisions to an existing plan instead of rewriting it in full with write_plan.",
      "Use write_plan only to create the plan initially, or when most of the plan content is changing.",
      "Each edits[].oldText must match exactly, including whitespace and newlines, and must be unique in the plan.",
    ],
    parameters: Type.Object({
      edits: Type.Array(
        Type.Object({
          oldText: Type.String({
            description:
              "Exact text for one targeted replacement. Must be unique in the current plan content and must not overlap with any other edits[].oldText in the same call.",
          }),
          newText: Type.String({
            description: "Replacement text for this targeted edit.",
          }),
        }),
        {
          description:
            "One or more targeted replacements, matched against the current plan content.",
        },
      ),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { edits } = params;
      if (!planMode) {
        const error = "edit_plan is only available in plan mode.";
        return {
          content: [{ type: "text", text: error }],
          details: { path: null },
        };
      }

      const path = getCurrentPlanPath();
      if (!path) {
        const error =
          "No plan has been written yet. Call write_plan first, then edit_plan.";
        return {
          content: [{ type: "text", text: error }],
          details: { path: null },
        };
      }

      return await planFileEditTool.execute(
        toolCallId,
        { path, edits },
        signal,
        onUpdate,
        ctx,
      );
    },

    renderCall(args, theme, context) {
      return renderPlanEditCall!(withCurrentPlanPath(args), theme, context);
    },

    renderResult(result, options, theme, context) {
      return planFileEditTool.renderResult!(
        result as AgentToolResult<EditToolDetails | undefined>,
        options,
        theme,
        {
          ...context,
          args: withCurrentPlanPath(context.args) as EditToolInput,
        },
      );
    },
  });

  registerToolWithGuidelines(pi, {
    name: SUBMIT_PLAN,
    label: "Submit plan",
    description:
      "Submit the plan that write_plan wrote for the user to approve. Only available in plan mode, and only after write_plan. " +
      "It submits whatever write_plan last wrote. Optionally suggest a different model to implement the plan; " +
      "the user decides whether to use it. " +
      "Asks the user whether to approve it, request changes, or stay in plan mode. Approval is the only way out of plan mode.",
    promptSnippet:
      "Submit the written plan for the user to approve, ending plan mode",
    promptGuidelines: [
      "Call submit_plan once write_plan holds the finished plan, rather than describing the plan and waiting for a reply.",
      "Only the user can leave plan mode, so never assume approval before submit_plan returns it.",
      "Suggest an implementation model via suggestedModel only when a different model is clearly better suited than the current one (for example a cheaper model for a mechanical plan); otherwise omit it.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
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

      const path = getCurrentPlanPath();
      if (!path) {
        const error =
          "No plan has been written yet. Call write_plan first, then submit_plan.";
        return {
          content: [{ type: "text", text: error }],
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
      const suggested =
        typeof args.suggestedModel === "string" && args.suggestedModel
          ? theme.fg("muted", ` suggests ${args.suggestedModel}`)
          : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("submit_plan")) + suggested,
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
            ? "no plan written yet"
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
      "Toggle plan mode, or review recorded tool decisions with `grants`",
    getArgumentCompletions: (prefix) =>
      "grants".startsWith(prefix)
        ? [{ value: "grants", label: "grants" }]
        : null,
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
      if (argument === FRESH_HANDOFF_ARGUMENT) {
        await startFreshHandoffSession(ctx);
        return;
      }
      ctx.ui.notify(
        `Unknown argument "${argument}". Use /plan to toggle or /plan grants to review.`,
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
      setCurrentPlanPath(restored.planPath);
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
  remove: () => void;
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
  ];
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
  const ungated = [...UNGATED_TOOLS]
    .filter((name) => !PLAN_TOOLS.includes(name))
    .join(", ");
  return [
    "Plan mode is active.",
    "",
    `- These tools are available as usual: ${ungated}.`,
    "- Every other tool, including bash and the unscoped read, write and edit, needs the user's approval for each call.",
    "- The repo_* tools are confined to the repository and prompt before reaching outside it, so prefer them over bash.",
    "- If a call is denied, do not retry it.",
    `- Write the plan with ${WRITE_PLAN}. For small revisions, use ${EDIT_PLAN} instead of rewriting the whole plan. Call ${SUBMIT_PLAN} when it is ready. Only the user can leave plan mode.`,
  ].join("\n");
}

function withCurrentPlanPath(
  args: Record<string, unknown>,
): Record<string, unknown> {
  return { ...args, path: getCurrentPlanPath() };
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

// The session's plan file is created once and then overwritten in place, so a plan that goes
// through several review rounds leaves one file behind instead of one per round.
async function writePlanFile(title: string, plan: string): Promise<string> {
  const path =
    getCurrentPlanPath() ?? join(plansDirectory(), planFileName(title));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, plan.endsWith("\n") ? plan : `${plan}\n`);
  setCurrentPlanPath(path);
  return path;
}


