import { stat } from "node:fs/promises";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { MODE_IDENTITIES } from "./lib/agent-mode.ts";
import { isInPlansDirectory, newPlanPath, plansDirectory } from "./lib/plan-file.ts";
import { activateMissingPlanTools, PLAN_PATH, SUBMIT_PLAN } from "./lib/plan-tools.ts";
import { SubmissionAction, submissionAction, submissionOptions } from "./lib/plan-mode-policy.ts";
import { commitPlanFileForUser } from "./lib/plan-commit.ts";
import { registerPlanSubmission, type PlanSubmissionOutcome, type PlanSubmissionParams, type PlanSubmissionResult } from "./lib/plan-submission.ts";
import { registerToolWithGuidelines } from "./lib/register-tool.ts";
import { registerRestrictedMode } from "./lib/restricted-mode.ts";
import { selectWithDefault } from "./lib/select-with-default.ts";
import { latestCustomData } from "./lib/session-entries.ts";

const CONTEXT_FULL = "Full context — inherit the whole conversation";
const CONTEXT_COMPACT = "Compact — summarize, then implement in a fresh turn";
const CONTEXT_FRESH = "Fresh session — only the plan file, nothing else";
const FRESH_HANDOFF_ARGUMENT = "fresh-handoff";
const PLAN_HANDOFF_ENTRY_TYPE = "plan-handoff";

export default function (pi: ExtensionAPI) {
  let pendingFreshHandoff: PlanHandoff | undefined;
  const plan = registerRestrictedMode(pi, {
    identity: MODE_IDENTITIES.planning,
    // A fresh handoff session exists to implement an approved plan, so --plan does not apply to it.
    requestedAtStartup: (event, context) => !(event.reason === "new" && latestPlanHandoff(context.sessionManager)),
  });

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
      plan.flushPendingToggle(context);
      if (!plan.isActive()) {
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
            : details?.outcome === "outside-plans-directory"
              ? "not in the plans directory"
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
      plan.flushPendingToggle(context);
      return plan.isActive();
    },
    async submit(params, signal, context) {
      signal?.throwIfAborted();
      plan.flushPendingToggle(context);
      if (plan.isActive() && !pi.getActiveTools().includes(SUBMIT_PLAN)) {
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
    plan.flushPendingToggle(context);
    if (!plan.isActive()) {
      const error = "submit_plan is only available in plan mode, which is off. Only the user can enable it.";
      return {
        content: [{ type: "text", text: error }],
        details: { path: null, outcome: "unavailable" },
      };
    }

    const blocked = plan.blockedReason(SUBMIT_PLAN);
    if (blocked) throw new Error(blocked);

    const { path } = params;
    if (!isInPlansDirectory(path)) {
      return {
        content: [{ type: "text", text: `${path} is outside the plans directory (${plansDirectory()}). Call plan_path for a plan file path, write the plan there, then call submit_plan with that path.` }],
        details: { path: null, outcome: "outside-plans-directory" },
      };
    }
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
      plan.leave(context);
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
    context: ExtensionContext,
  ): Promise<AgentToolResult<{ path: string; outcome: PlanSubmissionOutcome }>> {
    const models = await settledAvailableModels(context);
    if (models.length === 0) {
      return notApproved(
        planPath,
        "No models with configured auth are available.",
      );
    }

    const currentModelLabel = context.model
      ? `${context.model.provider}/${context.model.id}`
      : undefined;
    const modelOptions = models.map((model) => {
      const label = `${model.provider}/${model.id}`;
      return label === currentModelLabel ? `${label} (current)` : label;
    });
    // The list can exceed the screen, so use the scrolling selector and open it
    // preselected on the current model instead of index 0.
    const currentOption =
      modelOptions.find((option) => option.endsWith("(current)")) ??
      modelOptions[0];
    const modelChoice = await selectWithDefault(
      context.ui,
      "Implement with which model?",
      modelOptions,
      currentOption,
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
        context.ui,
        "Thinking level",
        levelOptions,
        levelOptions[supportedLevels.indexOf(level)],
      );
      if (levelChoice !== undefined) {
        level = supportedLevels[levelOptions.indexOf(levelChoice)];
      }
    }

    return await handOffToModel(planPath, selectedModel, level, context);
  }

  async function handOffToModel(
    planPath: string,
    selectedModel: Model<Api>,
    level: ModelThinkingLevel | undefined,
    context: ExtensionContext,
  ): Promise<AgentToolResult<{ path: string; outcome: PlanSubmissionOutcome }>> {
    const modelName = `${selectedModel.provider}/${selectedModel.id}`;
    const choice = await selectWithDefault(
      context.ui,
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
      plan.leave(context);
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
      context.ui.notify(`No API key for ${selectedModel.provider}.`, "error");
      return notApproved(
        planPath,
        `No API key is configured for ${selectedModel.provider}.`,
      );
    }
    // setModel re-clamps the current thinking level for the new model, so an
    // explicit choice has to be applied after the switch; without one the
    // clamped level stands.
    if (level !== undefined) pi.setThinkingLevel(level);

    plan.leave(context);

    if (compactFirst) {
      // Compaction aborts the run this tool call belongs to, so the kickoff has
      // to come from the completion callback instead of this tool result.
      const kickoff = () =>
        pi.sendUserMessage(`Implement the plan at ${planPath}.`);
      context.compact({
        onComplete: kickoff,
        onError: (error) => {
          context.ui.notify(`Compaction failed: ${error.message}`, "error");
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
    getArgumentCompletions: plan.completions,
    handler: async (args, context) => {
      const argument = args.trim();
      if (await plan.handleCommand(argument, context)) return;
      if (argument === FRESH_HANDOFF_ARGUMENT) {
        await startFreshHandoffSession(context);
        return;
      }
      context.ui.notify(
        `Unknown argument "${argument}". Use /plan to toggle, /plan grants to review, or /plan allow|deny <glob> to add a path rule.`,
        "error",
      );
    },
  });

  async function startFreshHandoffSession(
    context: ExtensionCommandContext,
  ): Promise<void> {
    const handoff = pendingFreshHandoff;
    pendingFreshHandoff = undefined;
    if (!handoff) {
      context.ui.notify("No fresh-session handoff is pending.", "error");
      return;
    }

    const { cancelled } = await context.newSession({
      parentSession: context.sessionManager.getSessionFile(),
      // setup runs before session_start fires in the new runtime, so the new
      // plan-mode instance finds this entry when it initializes.
      setup: async (sessionManager) => {
        sessionManager.appendCustomEntry(PLAN_HANDOFF_ENTRY_TYPE, handoff);
      },
    });
    if (cancelled) {
      context.ui.notify(
        "Fresh session was cancelled — still in the current session. Ask the agent to implement the plan here instead.",
        "warning",
      );
    }
  }

  pi.on("session_start", async (event, context) => {
    // A compatibility migration for loadouts saved without the planning tools, not a mode change.
    activateMissingPlanTools(pi);
    const handoff =
      event.reason === "new"
        ? latestPlanHandoff(context.sessionManager)
        : undefined;
    if (!handoff) return;
    // The new runtime's availability snapshot is still being computed while
    // session_start runs (an extension's provider is registered synchronously,
    // but its auth check lands in a later async pass), so getAvailable() may not
    // list the handoff model yet. find() reads the registered providers directly;
    // setModel still refuses a provider without configured auth.
    const model = context.modelRegistry.find(handoff.provider, handoff.modelId);
    if (!model || !(await pi.setModel(model))) {
      context.ui.notify(
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

  pi.on("session_tree", async () => {
    activateMissingPlanTools(pi);
  });
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

const OUTCOME_LABELS: Record<string, string | undefined> = {
  approved: "approved",
  refine: "needs changes",
  "handed-off": "handed off",
};

// getAvailable() is a snapshot that an in-flight availability pass has not
// necessarily updated yet (extension providers registered on this session's
// start land in a later async pass). Refreshing first is pi's documented way to
// settle the snapshot before a synchronous read; a failed refresh just leaves
// the snapshot as it was.
async function settledAvailableModels(context: ExtensionContext): Promise<Model<Api>[]> {
  await context.modelRegistry.refresh({ allowNetwork: false }).catch(() => undefined);
  return context.modelRegistry.getAvailable();
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
): AgentToolResult<{ path: string; outcome: PlanSubmissionOutcome }> {
  const text = reason
    ? `Plan at ${planPath} not approved. Still in plan mode. ${reason}`
    : `Plan at ${planPath} not approved. Still in plan mode.`;
  return {
    content: [{ type: "text", text }],
    details: { path: planPath, outcome: "saved" },
  };
}
