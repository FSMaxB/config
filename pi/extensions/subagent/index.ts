/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import { existsSync, rmdirSync, unlinkSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels, StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getMarkdownTheme, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { shortenPath } from "../lib/format.ts";
import { createLineSplitter } from "../lib/lines.ts";
import { latestPlanModeEntry, readPersistedDecisions } from "../lib/plan-decisions.ts";
import { captureChildPathPolicy } from "../lib/path-permissions.ts";
import { serializeChildPathPolicy, CHILD_POLICY_ENV, type ChildPathPolicy } from "../lib/path-permission-snapshot.ts";
import { registerToolWithGuidelines } from "../lib/register-tool.ts";
import { type AgentConfig, discoverAgents } from "./agents.ts";
import { guidanceTable, loadPolicyConfig, resolveSubagentModel, type SubagentModelConfig } from "./model-policy.ts";
import { planModeAllowedTools, type PersistedPlanDecisions } from "./plan-restrictions.ts";

const EXTENSION_DIRECTORY = dirname(fileURLToPath(import.meta.url));

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

export default function (pi: ExtensionAPI) {
  // In spawned children this extension only enforces restrictions; not registering
  // the subagent tool there also rules out recursive dispatch.
  if (process.env.PI_SUBAGENT_CHILD) {
    registerChildRestrictions(pi);
    return;
  }

  pi.on("before_agent_start", (event, ctx) => {
    if (!event.systemPromptOptions.selectedTools?.includes("subagent")) return;

    const guidance = guidanceTable({
      mainModel: ctx.model,
      availableModels: ctx.modelRegistry.getAvailable(),
      config: loadPolicyConfig(EXTENSION_DIRECTORY),
    });
    if (!guidance) return;

    return {
      systemPrompt: `${event.systemPrompt}\n\n## Subagent Model Guidance\n\n${guidance}`,
    };
  });

  const agentListing = discoverAgents()
    .map(({ name, description }) => `${name} (${description})`)
    .join(", ");

  registerToolWithGuidelines(pi, {
    name: "subagent",
    label: "Subagent",
    description:
      [
        "Delegate tasks to specialized subagents with isolated context.",
        ...(agentListing ? [`Available agents: ${agentListing}.`] : []),
        "Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
        'Model policy: omitting "model" inherits the session model and is always valid.',
        "A different cloud model must belong to the session model's provider family; local models are always allowed.",
        "When the session itself runs on a local model, only local models are valid and switching is discouraged — prefer lowering thinkingLevel on the inherited model instead.",
        "Lowering thinkingLevel is generally the cheapest lever for easy tasks.",
      ].join(" "),
    promptSnippet: "Delegate exploration and other self-contained tasks to isolated subagents",
    promptGuidelines: [
      "Prefer dispatching the explore subagent for multi-file codebase exploration instead of reading many files into the main context; it returns a compressed report.",
      "Dispatch independent explorations in parallel, and trust the returned report instead of re-reading the same files yourself.",
      "Pick a cheaper model or a lower thinkingLevel for subagent tasks that don't need the session model's full capability.",
    ],
    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const planEntry = latestPlanModeEntry(ctx.sessionManager);
      const planAllowedTools = planEntry?.enabled
        ? planModeAllowedTools(
            {
              enabled: true,
              sessionGrants: planEntry.sessionGrants,
              sessionDenials: planEntry.sessionDenials.map((denial) => denial.name),
            },
            await persistedPlanDecisions(),
          )
        : undefined;
      const dispatch: DispatchContext = {
        mainModel: ctx.model,
        thinkingLevel: ctx.thinkingLevel,
        availableModels: ctx.modelRegistry.getAvailable(),
        policyConfig: loadPolicyConfig(EXTENSION_DIRECTORY),
        planAllowedTools,
        pathPolicy: await captureChildPathPolicy(),
      };
      const agents = discoverAgents();

      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

      const makeDetails =
        (mode: "single" | "parallel" | "chain") =>
        (results: SingleResult[]): SubagentDetails => ({
          mode,
          results,
        });

      if (modeCount !== 1) {
        const available = agents.map((agent) => `"${agent.name}"`).join(", ") || "none";
        return {
          content: [
            {
              type: "text",
              text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
            },
          ],
          details: makeDetails("single")([]),
        };
      }

      if (params.chain && params.chain.length > 0) {
        const results: SingleResult[] = [];
        let previousOutput = "";

        for (let i = 0; i < params.chain.length; i++) {
          const step = params.chain[i];
          const taskWithContext = step.task.replace(/\{previous\}/g, () => previousOutput);

          const chainUpdate: OnUpdateCallback | undefined = onUpdate
            ? (partial) => {
                const currentResult = partial.details?.results[0];
                if (currentResult) {
                  const allResults = [...results, currentResult];
                  onUpdate({
                    content: partial.content,
                    details: makeDetails("chain")(allResults),
                  });
                }
              }
            : undefined;

          const result = await runSingleAgent(
            ctx.cwd,
            dispatch,
            agents,
            step.agent,
            taskWithContext,
            { model: step.model, thinkingLevel: step.thinkingLevel },
            step.cwd,
            i + 1,
            signal,
            chainUpdate,
            makeDetails("chain"),
          );
          results.push(result);

          if (isFailedResult(result)) {
            const errorMessage = getResultOutput(result);
            return {
              content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMessage}` }],
              details: makeDetails("chain")(results),
            };
          }
          previousOutput = getFinalOutput(result.messages);
        }
        return {
          content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
          details: makeDetails("chain")(results),
        };
      }

      if (params.tasks && params.tasks.length > 0) {
        if (params.tasks.length > MAX_PARALLEL_TASKS)
          return {
            content: [
              {
                type: "text",
                text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
              },
            ],
            details: makeDetails("parallel")([]),
          };

        const allResults: SingleResult[] = new Array(params.tasks.length);
        for (let i = 0; i < params.tasks.length; i++) {
          const taskItem = params.tasks[i];
          const agent = agents.find((candidate) => candidate.name === taskItem.agent);
          const configuration = agent
            ? resolveTaskConfiguration(agent, { model: taskItem.model, thinkingLevel: taskItem.thinkingLevel }, dispatch)
            : {
                model:
                  taskItem.model ??
                  (dispatch.mainModel ? `${dispatch.mainModel.provider}/${dispatch.mainModel.id}` : undefined),
                thinkingLevel: taskItem.thinkingLevel ?? dispatch.thinkingLevel,
              };
          allResults[i] = {
            agent: taskItem.agent,
            task: taskItem.task,
            exitCode: -1, // -1 = still running
            messages: [],
            stderr: "",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
            model: configuration.model,
            thinkingLevel: configuration.thinkingLevel,
          };
        }

        const emitParallelUpdate = () => {
          if (onUpdate) {
            const running = allResults.filter((result) => result.exitCode === -1).length;
            const done = allResults.filter((result) => result.exitCode !== -1).length;
            onUpdate({
              content: [
                { type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
              ],
              details: makeDetails("parallel")([...allResults]),
            });
          }
        };

        const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (taskItem, index) => {
          const result = await runSingleAgent(
            ctx.cwd,
            dispatch,
            agents,
            taskItem.agent,
            taskItem.task,
            { model: taskItem.model, thinkingLevel: taskItem.thinkingLevel },
            taskItem.cwd,
            undefined,
            signal,
            (partial) => {
              if (partial.details?.results[0]) {
                allResults[index] = partial.details.results[0];
                emitParallelUpdate();
              }
            },
            makeDetails("parallel"),
          );
          allResults[index] = result;
          emitParallelUpdate();
          return result;
        });

        const successCount = results.filter((result) => !isFailedResult(result)).length;
        const summaries = results.map((result) => {
          const output = truncateParallelOutput(getResultOutput(result));
          const status = isFailedResult(result)
            ? `failed${result.stopReason && result.stopReason !== "end" ? ` (${result.stopReason})` : ""}`
            : "completed";
          return `### [${result.agent}] ${status}\n\n${output}`;
        });
        return {
          content: [
            {
              type: "text",
              text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
            },
          ],
          details: makeDetails("parallel")(results),
        };
      }

      if (params.agent && params.task) {
        const result = await runSingleAgent(
          ctx.cwd,
          dispatch,
          agents,
          params.agent,
          params.task,
          { model: params.model, thinkingLevel: params.thinkingLevel },
          params.cwd,
          undefined,
          signal,
          onUpdate,
          makeDetails("single"),
        );
        if (isFailedResult(result)) {
          const errorMessage = getResultOutput(result);
          return {
            content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMessage}` }],
            details: makeDetails("single")([result]),
          };
        }
        return {
          content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
          details: makeDetails("single")([result]),
        };
      }

      const available = agents.map((agent) => `"${agent.name}"`).join(", ") || "none";
      return {
        content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
        details: makeDetails("single")([]),
      };
    },

    renderCall(args, theme, _context) {
      if (args.chain && args.chain.length > 0) {
        let text =
          theme.fg("toolTitle", theme.bold("subagent ")) +
          theme.fg("accent", `chain (${args.chain.length} steps)`);
        for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
          const step = args.chain[i];
          const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
          const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
          text +=
            "\n  " +
            theme.fg("muted", `${i + 1}.`) +
            " " +
            theme.fg("accent", step.agent) +
            formatAgentConfiguration(step.model, step.thinkingLevel, "inherit", theme) +
            theme.fg("dim", ` ${preview}`);
        }
        if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }
      if (args.tasks && args.tasks.length > 0) {
        let text =
          theme.fg("toolTitle", theme.bold("subagent ")) +
          theme.fg("accent", `parallel (${args.tasks.length} tasks)`);
        for (const taskItem of args.tasks.slice(0, 3)) {
          const preview = taskItem.task.length > 40 ? `${taskItem.task.slice(0, 40)}...` : taskItem.task;
          text +=
            `\n  ${theme.fg("accent", taskItem.agent)}` +
            formatAgentConfiguration(taskItem.model, taskItem.thinkingLevel, "inherit", theme) +
            theme.fg("dim", ` ${preview}`);
        }
        if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }
      const agentName = args.agent || "...";
      const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
      let text =
        theme.fg("toolTitle", theme.bold("subagent ")) +
        theme.fg("accent", agentName) +
        formatAgentConfiguration(args.model, args.thinkingLevel, "inherit", theme);
      text += `\n  ${theme.fg("dim", preview)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as SubagentDetails | undefined;
      if (!details || details.results.length === 0) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
      }

      const markdownTheme = getMarkdownTheme();

      if (details.mode === "single" && details.results.length === 1) {
        const single = details.results[0];
        const isError = isFailedResult(single);
        const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const displayItems = getDisplayItems(single.messages);
        const finalOutput = getFinalOutput(single.messages);

        if (expanded) {
          const container = new Container();
          let header =
            `${icon} ${theme.fg("toolTitle", theme.bold(single.agent))}` +
            formatAgentConfiguration(single.model, single.thinkingLevel, "unresolved", theme);
          if (isError && single.stopReason) header += ` ${theme.fg("error", `[${single.stopReason}]`)}`;
          container.addChild(new Text(header, 0, 0));
          if (isError && single.errorMessage)
            container.addChild(new Text(theme.fg("error", `Error: ${single.errorMessage}`), 0, 0));
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
          container.addChild(new Text(theme.fg("dim", single.task), 0, 0));
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
          if (displayItems.length === 0 && !finalOutput) {
            container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
          } else {
            for (const item of displayItems) {
              if (item.type === "toolCall")
                container.addChild(
                  new Text(
                    theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
                    0,
                    0,
                  ),
                );
            }
            if (finalOutput) {
              container.addChild(new Spacer(1));
              container.addChild(new Markdown(finalOutput.trim(), 0, 0, markdownTheme));
            }
          }
          const usageText = formatUsageStats(single.usage);
          if (usageText) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg("dim", usageText), 0, 0));
          }
          return container;
        }

        let text =
          `${icon} ${theme.fg("toolTitle", theme.bold(single.agent))}` +
          formatAgentConfiguration(single.model, single.thinkingLevel, "unresolved", theme);
        if (isError && single.stopReason) text += ` ${theme.fg("error", `[${single.stopReason}]`)}`;
        if (isError && single.errorMessage) text += `\n${theme.fg("error", `Error: ${single.errorMessage}`)}`;
        else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
        else {
          text += `\n${renderCollapsedItems(displayItems, COLLAPSED_ITEM_COUNT, expanded, theme)}`;
          if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        }
        const usageText = formatUsageStats(single.usage);
        if (usageText) text += `\n${theme.fg("dim", usageText)}`;
        return new Text(text, 0, 0);
      }

      if (details.mode === "chain") {
        const successCount = details.results.filter((item) => !isFailedResult(item)).length;
        const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

        if (expanded) {
          const container = new Container();
          container.addChild(
            new Text(
              icon +
                " " +
                theme.fg("toolTitle", theme.bold("chain ")) +
                theme.fg("accent", `${successCount}/${details.results.length} steps`),
              0,
              0,
            ),
          );

          for (const item of details.results) {
            const itemIcon = !isFailedResult(item) ? theme.fg("success", "✓") : theme.fg("error", "✗");
            const header =
              theme.fg("muted", `─── Step ${item.step}: `) +
              theme.fg("accent", item.agent) +
              formatAgentConfiguration(item.model, item.thinkingLevel, "unresolved", theme) +
              ` ${itemIcon}`;
            renderTaskSection(container, header, item, theme, markdownTheme);
          }

          const usageText = formatUsageStats(aggregateUsage(details.results));
          if (usageText) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg("dim", `Total: ${usageText}`), 0, 0));
          }
          return container;
        }

        let text =
          icon +
          " " +
          theme.fg("toolTitle", theme.bold("chain ")) +
          theme.fg("accent", `${successCount}/${details.results.length} steps`);
        for (const item of details.results) {
          const itemIcon = !isFailedResult(item) ? theme.fg("success", "✓") : theme.fg("error", "✗");
          const displayItems = getDisplayItems(item.messages);
          text +=
            `\n\n${theme.fg("muted", `─── Step ${item.step}: `)}${theme.fg("accent", item.agent)}` +
            formatAgentConfiguration(item.model, item.thinkingLevel, "unresolved", theme) +
            ` ${itemIcon}`;
          if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
          else text += `\n${renderCollapsedItems(displayItems, 5, expanded, theme)}`;
        }
        const usageText = formatUsageStats(aggregateUsage(details.results));
        if (usageText) text += `\n\n${theme.fg("dim", `Total: ${usageText}`)}`;
        text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        return new Text(text, 0, 0);
      }

      if (details.mode === "parallel") {
        const running = details.results.filter((item) => item.exitCode === -1).length;
        const successCount = details.results.filter((item) => item.exitCode !== -1 && !isFailedResult(item)).length;
        const failCount = details.results.filter((item) => item.exitCode !== -1 && isFailedResult(item)).length;
        const isRunning = running > 0;
        const icon = isRunning
          ? theme.fg("warning", "⏳")
          : failCount > 0
            ? theme.fg("warning", "◐")
            : theme.fg("success", "✓");
        const status = isRunning
          ? `${successCount + failCount}/${details.results.length} done, ${running} running`
          : `${successCount}/${details.results.length} tasks`;

        if (expanded && !isRunning) {
          const container = new Container();
          container.addChild(
            new Text(
              `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
              0,
              0,
            ),
          );

          for (const item of details.results) {
            const itemIcon = isFailedResult(item) ? theme.fg("error", "✗") : theme.fg("success", "✓");
            const header =
              theme.fg("muted", "─── ") +
              theme.fg("accent", item.agent) +
              formatAgentConfiguration(item.model, item.thinkingLevel, "unresolved", theme) +
              ` ${itemIcon}`;
            renderTaskSection(container, header, item, theme, markdownTheme);
          }

          const usageText = formatUsageStats(aggregateUsage(details.results));
          if (usageText) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg("dim", `Total: ${usageText}`), 0, 0));
          }
          return container;
        }

        let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
        for (const item of details.results) {
          const itemIcon =
            item.exitCode === -1
              ? theme.fg("warning", "⏳")
              : isFailedResult(item)
                ? theme.fg("error", "✗")
                : theme.fg("success", "✓");
          const displayItems = getDisplayItems(item.messages);
          text +=
            `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", item.agent)}` +
            formatAgentConfiguration(item.model, item.thinkingLevel, "unresolved", theme) +
            ` ${itemIcon}`;
          if (displayItems.length === 0)
            text += `\n${theme.fg("muted", item.exitCode === -1 ? "(running...)" : "(no output)")}`;
          else text += `\n${renderCollapsedItems(displayItems, 5, expanded, theme)}`;
        }
        if (!isRunning) {
          const usageText = formatUsageStats(aggregateUsage(details.results));
          if (usageText) text += `\n\n${theme.fg("dim", `Total: ${usageText}`)}`;
        }
        if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        return new Text(text, 0, 0);
      }

      const text = result.content[0];
      return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
    },
  });
}

const ModelParam = Type.Optional(
  Type.String({
    description:
      'Model for this subagent as "provider/id" (a bare id works when unambiguous). Omit to inherit the session model, which is always valid.',
  }),
);

const ThinkingLevelParam = Type.Optional(
  StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, {
    description:
      "Thinking level for this subagent. Omit to inherit the session's level. Lowering it on the inherited model is the cheapest way to scale effort down.",
  }),
);

const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate to the agent" }),
  model: ModelParam,
  thinkingLevel: ThinkingLevelParam,
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
  model: ModelParam,
  thinkingLevel: ThinkingLevelParam,
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
  task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
  model: ModelParam,
  thinkingLevel: ThinkingLevelParam,
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
  chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

interface SingleResult {
  agent: string;
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
}

interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  results: SingleResult[];
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

interface DispatchContext {
  mainModel: Model<Api> | undefined;
  thinkingLevel?: ThinkingLevel;
  availableModels: Model<Api>[];
  policyConfig: SubagentModelConfig;
  planAllowedTools: Set<string> | undefined;
  pathPolicy: ChildPathPolicy;
}

interface TaskOverrides {
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
}

async function runSingleAgent(
  defaultCwd: string,
  dispatch: DispatchContext,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  overrides: TaskOverrides,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
  const agent = agents.find((candidate) => candidate.name === agentName);

  if (!agent) {
    const available = agents.map((candidate) => `"${candidate.name}"`).join(", ") || "none";
    return {
      agent: agentName,
      task,
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      model:
        overrides.model ??
        (dispatch.mainModel ? `${dispatch.mainModel.provider}/${dispatch.mainModel.id}` : undefined),
      thinkingLevel: overrides.thinkingLevel ?? dispatch.thinkingLevel,
      step,
    };
  }

  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  const configuration = resolveTaskConfiguration(agent, overrides, dispatch);
  if (!configuration.ok) return policyFailure(agent, task, step, configuration.error, configuration);
  const { model, thinkingLevel } = configuration;
  if (model) args.push("--model", model);
  if (thinkingLevel) args.push("--thinking", thinkingLevel);

  const planAllowedTools = dispatch.planAllowedTools;
  if (planAllowedTools && agent.tools && !agent.tools.some((tool) => planAllowedTools.has(tool))) {
    return policyFailure(
      agent,
      task,
      step,
      `Plan mode restricts every tool of agent "${agent.name}", so dispatching it would be pointless. ` +
        `Tools currently allowed for subagents: ${[...planAllowedTools].sort().join(", ")}.`,
      configuration,
    );
  }
  if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

  let temporaryPromptDirectory: string | null = null;
  let temporaryPromptPath: string | null = null;

  const currentResult: SingleResult = {
    agent: agentName,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model,
    thinkingLevel,
    step,
  };

  const emitUpdate = () => {
    if (onUpdate) {
      onUpdate({
        content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
        details: makeDetails([currentResult]),
      });
    }
  };

  try {
    if (agent.systemPrompt.trim()) {
      const promptFile = await writePromptToTempFile(agent.name, agent.systemPrompt);
      temporaryPromptDirectory = promptFile.directory;
      temporaryPromptPath = promptFile.filePath;
      args.push("--append-system-prompt", temporaryPromptPath);
    }

    args.push(`Task: ${task}`);
    let wasAborted = false;

    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      const child = spawn(invocation.command, invocation.args, {
        cwd: cwd ?? defaultCwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnvironment(dispatch),
      });
      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        if (event.type === "message_end" && event.message) {
          const message = event.message as Message;
          currentResult.messages.push(message);

          if (message.role === "assistant") {
            currentResult.usage.turns++;
            const usage = message.usage;
            if (usage) {
              currentResult.usage.input += usage.input || 0;
              currentResult.usage.output += usage.output || 0;
              currentResult.usage.cacheRead += usage.cacheRead || 0;
              currentResult.usage.cacheWrite += usage.cacheWrite || 0;
              currentResult.usage.cost += usage.cost?.total || 0;
              currentResult.usage.contextTokens = usage.totalTokens || 0;
            }
            if (!currentResult.model && message.model) currentResult.model = message.model;
            if (message.stopReason) currentResult.stopReason = message.stopReason;
            if (message.errorMessage) currentResult.errorMessage = message.errorMessage;
          }
          emitUpdate();
        }

        if (event.type === "tool_result_end" && event.message) {
          currentResult.messages.push(event.message as Message);
          emitUpdate();
        }
      };

      const splitter = createLineSplitter(processLine);
      child.stdout.on("data", (data) => splitter.push(data.toString()));

      child.stderr.on("data", (data) => {
        currentResult.stderr += data.toString();
      });

      child.on("close", (code) => {
        splitter.flush();
        resolve(code ?? 0);
      });

      child.on("error", (error) => {
        currentResult.stderr += `Failed to spawn ${invocation.command}: ${error.message}`;
        resolve(1);
      });

      if (signal) {
        const killChild = () => {
          wasAborted = true;
          child.kill("SIGTERM");
          setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          }, 5000);
        };
        if (signal.aborted) killChild();
        else signal.addEventListener("abort", killChild, { once: true });
      }
    });

    currentResult.exitCode = exitCode;
    if (wasAborted) throw new Error("Subagent was aborted");
    return currentResult;
  } finally {
    if (temporaryPromptPath)
      try {
        unlinkSync(temporaryPromptPath);
      } catch {
        /* ignore */
      }
    if (temporaryPromptDirectory)
      try {
        rmdirSync(temporaryPromptDirectory);
      } catch {
        /* ignore */
      }
  }
}

function resolveTaskConfiguration(
  agent: AgentConfig,
  overrides: TaskOverrides,
  dispatch: DispatchContext,
): TaskConfiguration {
  const requestedModel = overrides.model ?? agent.model;
  const fallbackModel =
    requestedModel ?? (dispatch.mainModel ? `${dispatch.mainModel.provider}/${dispatch.mainModel.id}` : undefined);
  const requestedThinkingLevel = overrides.thinkingLevel ?? agent.thinkingLevel;
  const inheritedThinkingLevel = requestedThinkingLevel ?? dispatch.thinkingLevel;
  const resolution = resolveSubagentModel({
    requested: requestedModel,
    mainModel: dispatch.mainModel,
    availableModels: dispatch.availableModels,
    config: dispatch.policyConfig,
  });
  if (!resolution.ok) {
    return {
      ok: false,
      error: resolution.error,
      model: fallbackModel,
      thinkingLevel: inheritedThinkingLevel,
    };
  }

  const childModel = resolution.model;
  const model = childModel ? `${childModel.provider}/${childModel.id}` : fallbackModel;
  if (!childModel || !inheritedThinkingLevel) {
    return { ok: true, model, thinkingLevel: inheritedThinkingLevel };
  }

  const supportedLevels = getSupportedThinkingLevels(childModel);
  if (supportedLevels.includes(inheritedThinkingLevel)) {
    return { ok: true, model, thinkingLevel: inheritedThinkingLevel };
  }
  if (requestedThinkingLevel) {
    return {
      ok: false,
      error:
        `Thinking level "${requestedThinkingLevel}" is not supported by ${model}. ` +
        `Supported levels: ${supportedLevels.join(", ")}.`,
      model,
      thinkingLevel: requestedThinkingLevel,
    };
  }
  return {
    ok: true,
    model,
    thinkingLevel: clampThinkingLevel(childModel, inheritedThinkingLevel),
  };
}

// Reused for every dispatch-side policy rejection so failures render with the
// same resolved configuration metadata as successful tasks.
function policyFailure(
  agent: AgentConfig,
  task: string,
  step: number | undefined,
  message: string,
  configuration?: Pick<TaskConfiguration, "model" | "thinkingLevel">,
): SingleResult {
  return {
    agent: agent.name,
    task,
    exitCode: 1,
    messages: [],
    stderr: message,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model: configuration?.model,
    thinkingLevel: configuration?.thinkingLevel,
    step,
  };
}

type TaskConfiguration = {
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
} & ({ ok: true } | { ok: false; error: string });

function childEnvironment(dispatch: DispatchContext): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, PI_SUBAGENT_CHILD: "1" };
  delete environment.PI_SUBAGENT_PLAN_ALLOWED_TOOLS;
  delete environment[CHILD_POLICY_ENV];
  if (dispatch.planAllowedTools) environment.PI_SUBAGENT_PLAN_ALLOWED_TOOLS = [...dispatch.planAllowedTools].sort().join(",");
  environment[CHILD_POLICY_ENV] = serializeChildPathPolicy(dispatch.pathPolicy);
  return environment;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

async function writePromptToTempFile(
  agentName: string,
  prompt: string,
): Promise<{ directory: string; filePath: string }> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = join(temporaryDirectory, `prompt-${safeName}.md`);
  await withFileMutationQueue(filePath, async () => {
    await writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  });
  return { directory: temporaryDirectory, filePath };
}

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

function isFailedResult(result: SingleResult): boolean {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
  if (isFailedResult(result)) {
    return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
  }
  return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
  const byteLength = Buffer.byteLength(output, "utf8");
  if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

  let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
  while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
    truncated = truncated.slice(0, -1);
  }
  // The byte-trimming loop above can stop right after a lone high surrogate.
  if (/[\uD800-\uDBFF]$/.test(truncated)) truncated = truncated.slice(0, -1);
  return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  mapper: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await mapper(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "text") items.push({ type: "text", text: part.text });
        else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
      }
    }
  }
  return items;
}

function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: (color: any, text: string) => string,
): string {
  switch (toolName) {
    case "bash": {
      const command = (args.command as string) || "...";
      const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
      return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
    }
    case "read": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const filePath = shortenPath(rawPath);
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      let text = themeFg("accent", filePath);
      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1;
        const endLine = limit !== undefined ? startLine + limit - 1 : "";
        text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
      }
      return themeFg("muted", `${toolName} `) + text;
    }
    case "write": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const filePath = shortenPath(rawPath);
      const content = (args.content || "") as string;
      const lines = content.split("\n").length;
      let text = themeFg("muted", `${toolName} `) + themeFg("accent", filePath);
      if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
      return text;
    }
    case "edit": {
      const rawPath = (args.file_path || args.path || "...") as string;
      return themeFg("muted", `${toolName} `) + themeFg("accent", shortenPath(rawPath));
    }
    case "ls":
    case "delete": {
      const rawPath = (args.path || ".") as string;
      return themeFg("muted", `${toolName} `) + themeFg("accent", shortenPath(rawPath));
    }
    case "find": {
      const pattern = (args.pattern || "*") as string;
      const rawPath = (args.path || ".") as string;
      return (
        themeFg("muted", `${toolName} `) + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`)
      );
    }
    case "grep": {
      const pattern = (args.pattern || "") as string;
      const rawPath = (args.path || ".") as string;
      return (
        themeFg("muted", `${toolName} `) +
        themeFg("accent", `/${pattern}/`) +
        themeFg("dim", ` in ${shortenPath(rawPath)}`)
      );
    }
    default: {
      const argsText = JSON.stringify(args);
      const preview = argsText.length > 50 ? `${argsText.slice(0, 50)}...` : argsText;
      return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
    }
  }
}

function renderCollapsedItems(
  items: DisplayItem[],
  limit: number | undefined,
  expanded: boolean,
  theme: { fg: (color: any, text: string) => string },
): string {
  const toShow = limit ? items.slice(-limit) : items;
  const skipped = limit && items.length > limit ? items.length - limit : 0;
  let text = "";
  if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
  for (const item of toShow) {
    if (item.type === "text") {
      const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
      text += `${theme.fg("toolOutput", preview)}\n`;
    } else {
      text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
    }
  }
  return text.trimEnd();
}

// Shared by the chain and parallel expanded views, whose per-item blocks are otherwise
// identical: a header line (caller-formatted, since chain and parallel label it differently),
// the task text, any tool calls, the final markdown output, and per-item usage stats.
function renderTaskSection(
  container: Container,
  header: string,
  item: SingleResult,
  theme: { fg: (color: any, text: string) => string },
  markdownTheme: ReturnType<typeof getMarkdownTheme>,
): void {
  const displayItems = getDisplayItems(item.messages);
  const finalOutput = getFinalOutput(item.messages);

  container.addChild(new Spacer(1));
  container.addChild(new Text(header, 0, 0));
  container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", item.task), 0, 0));

  for (const displayItem of displayItems) {
    if (displayItem.type === "toolCall") {
      container.addChild(
        new Text(
          theme.fg("muted", "→ ") + formatToolCall(displayItem.name, displayItem.args, theme.fg.bind(theme)),
          0,
          0,
        ),
      );
    }
  }

  if (finalOutput) {
    container.addChild(new Spacer(1));
    container.addChild(new Markdown(finalOutput.trim(), 0, 0, markdownTheme));
  }

  const usageText = formatUsageStats(item.usage);
  if (usageText) container.addChild(new Text(theme.fg("dim", usageText), 0, 0));
}

function aggregateUsage(results: SingleResult[]) {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
  for (const result of results) {
    total.input += result.usage.input;
    total.output += result.usage.output;
    total.cacheRead += result.usage.cacheRead;
    total.cacheWrite += result.usage.cacheWrite;
    total.cost += result.usage.cost;
    total.turns += result.usage.turns;
  }
  return total;
}

function formatAgentConfiguration(
  model: string | undefined,
  thinkingLevel: ModelThinkingLevel | undefined,
  fallback: "inherit" | "unresolved",
  theme: { fg: (color: any, text: string) => string },
): string {
  return theme.fg("dim", ` [model: ${model ?? fallback} · thinking: ${thinkingLevel ?? fallback}]`);
}

function formatUsageStats(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens?: number;
  turns?: number;
}): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) {
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  }
  return parts.join(" ");
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function registerChildRestrictions(pi: ExtensionAPI): void {
  const allowedList = process.env.PI_SUBAGENT_PLAN_ALLOWED_TOOLS;
  if (allowedList === undefined) return;

  const allowedTools = new Set(allowedList.split(",").filter(Boolean));
  pi.on("tool_call", async (event) => {
    if (allowedTools.has(event.toolName)) return;
    // The allowlist covers tools this agent may not even have; only name the usable ones.
    const usableTools = pi.getActiveTools().filter((name) => allowedTools.has(name));
    return {
      block: true,
      reason:
        `${event.toolName} is unavailable: the dispatching session is in plan mode, which restricts subagents to read-only tools. ` +
        `Do not retry it. Tools you can use: ${usableTools.sort().join(", ")}.`,
    };
  });
}

async function persistedPlanDecisions(): Promise<PersistedPlanDecisions> {
  const { alwaysAllowed, alwaysDenied } = await readPersistedDecisions();
  return { alwaysAllowed, alwaysDenied: alwaysDenied.map((denial) => denial.name) };
}
