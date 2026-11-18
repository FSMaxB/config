import {
  estimateTokens,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { shortenPath } from "./lib/format.ts";
import {
  collectContextMessages,
  measureTranscriptSystem,
  splitContextMessages,
} from "./lib/context-messages.ts";
import { modelLabel } from "./lib/default-model.ts";

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("context", {
    description: "Show detailed stats on how the context window is used",
    handler: async (_commandArguments, context) => {
      context.ui.notify(buildReport(pi, context), "info");
    },
  });
}

function buildReport(
  pi: ExtensionAPI,
  context: ExtensionCommandContext,
): string {
  const { messages, systemMessages } = splitContextMessages(
    collectContextMessages(
      context.sessionManager,
      sessionEntryToContextMessages,
    ),
  );
  const sections = [
    ...(systemMessages.length > 0
      ? buildTranscriptSystemRows(systemMessages)
      : [buildSystemPromptRows(context), buildToolRows(pi)]),
    buildMessageRows(messages),
  ];
  const estimatedTotal = sections.reduce(
    (sum, rows) => sum + (rows[0]?.tokens ?? 0),
    0,
  );

  const usage = context.getContextUsage();
  const contextTokens = usage?.tokens ?? estimatedTotal;
  const contextWindow = usage?.contextWindow;
  const model = context.model;

  const lines = [
    `Context usage — ${model ? modelLabel(model) : "no model"}`,
    "",
  ];
  if (contextWindow) {
    lines.push(usageBar(contextTokens, contextWindow));
    lines.push(
      `${formatTokens(contextTokens)} of ${formatTokens(contextWindow)} tokens · ` +
        `${formatTokens(Math.max(0, contextWindow - contextTokens))} free`,
    );
  } else {
    lines.push(
      `${formatTokens(contextTokens)} tokens (context window unknown)`,
    );
  }
  lines.push("");
  lines.push(...renderRows(sections.flat(), contextWindow));
  lines.push("");
  if (systemMessages.length > 0) {
    lines.push(
      "System/tool rows estimate stored transcript declarations, including updates; " +
        "providers may fold these into the current prompt and tools.",
    );
  }
  lines.push(
    usage?.tokens != null
      ? `Total is provider-reported (last response + trailing estimate); ` +
          `component breakdown uses the chars/4 heuristic and sums to ${formatTokens(estimatedTotal)}.`
      : "No provider-reported usage yet; everything shown uses the chars/4 heuristic.",
  );
  return lines.join("\n");
}

function buildTranscriptSystemRows(
  messages: Parameters<typeof measureTranscriptSystem>[0],
): Row[][] {
  const { instructionCharacters, toolCharacters, toolDeclarations } =
    measureTranscriptSystem(messages);
  return [
    [
      {
        indent: 0,
        label: "System instructions (transcript)",
        tokens: estimateCharacters(instructionCharacters),
        note: `${messages.length} system entries`,
      },
    ],
    [
      {
        indent: 0,
        label: "Tool declarations (transcript)",
        tokens: estimateCharacters(toolCharacters),
        note: `${toolDeclarations} declarations, including redeclarations`,
      },
    ],
  ];
}

function buildSystemPromptRows(context: ExtensionCommandContext): Row[] {
  const totalTokens = estimateText(context.getSystemPrompt());
  const options = context.getSystemPromptOptions();

  const fileRows = (options.contextFiles ?? []).map((file) => ({
    indent: 1,
    label: shortenPath(file.path),
    tokens: estimateText(file.content),
  }));
  const skills = options.skills ?? [];
  const skillTokens = estimateText(
    skills
      .map((skill) => `${skill.name} ${skill.description} ${skill.filePath}`)
      .join("\n"),
  );
  const appendTokens = estimateText(options.appendSystemPrompt ?? "");
  const childTokens =
    fileRows.reduce((sum, row) => sum + row.tokens, 0) +
    skillTokens +
    appendTokens;

  const rows: Row[] = [
    { indent: 0, label: "System prompt", tokens: totalTokens },
    {
      indent: 1,
      label: "base prompt",
      tokens: Math.max(0, totalTokens - childTokens),
    },
    ...fileRows,
  ];
  if (skills.length > 0) {
    rows.push({
      indent: 1,
      label: "skills list",
      tokens: skillTokens,
      note: `${skills.length} skills`,
    });
  }
  if (appendTokens > 0) {
    rows.push({ indent: 1, label: "appended prompt", tokens: appendTokens });
  }
  return rows;
}

// The largest tool declarations; the rest are summed in one row.
const TOOL_ROW_LIMIT = 10;

function buildToolRows(pi: ExtensionAPI): Row[] {
  const activeNames = new Set(pi.getActiveTools());
  const tools = pi
    .getAllTools()
    .filter((tool) => activeNames.has(tool.name))
    .map(({ name, description, parameters }) => ({
      name,
      tokens: estimateText(JSON.stringify({ name, description, parameters })),
    }))
    .sort((a, b) => b.tokens - a.tokens);
  const totalTokens = tools.reduce((sum, tool) => sum + tool.tokens, 0);

  const rows: Row[] = [
    {
      indent: 0,
      label: "Tool definitions",
      tokens: totalTokens,
      note: `${tools.length} tools`,
    },
    ...tools.slice(0, TOOL_ROW_LIMIT).map((tool) => ({
      indent: 1,
      label: tool.name,
      tokens: tool.tokens,
    })),
  ];
  const rest = tools.slice(TOOL_ROW_LIMIT);
  if (rest.length > 0) {
    rows.push({
      indent: 1,
      label: `(${rest.length} more)`,
      tokens: rest.reduce((sum, tool) => sum + tool.tokens, 0),
    });
  }
  return rows;
}

function buildMessageRows(
  messages: ReturnType<typeof sessionEntryToContextMessages>,
): Row[] {
  const totals = new Map<"user" | "bash" | "summary", Stats>();
  const toolResults = new Map<string, Stats>();
  const customMessages = new Map<string, Stats>();
  let assistantTextChars = 0;
  let assistantThinkingChars = 0;
  let toolCallChars = 0;

  for (const message of messages) {
    switch (message.role) {
      case "user":
        tally(totals, "user", estimateTokens(message));
        break;
      case "assistant":
        for (const block of message.content) {
          if (block.type === "text") {
            assistantTextChars += block.text.length;
          } else if (block.type === "thinking") {
            assistantThinkingChars += block.thinking.length;
          } else if (block.type === "toolCall") {
            toolCallChars +=
              block.name.length + JSON.stringify(block.arguments).length;
          }
        }
        break;
      case "toolResult":
        tally(toolResults, message.toolName, estimateTokens(message));
        break;
      case "custom":
        tally(customMessages, message.customType, estimateTokens(message));
        break;
      case "bashExecution":
        tally(totals, "bash", estimateTokens(message));
        break;
      case "compactionSummary":
      case "branchSummary":
        tally(totals, "summary", estimateTokens(message));
        break;
      case "system":
        // splitContextMessages moves system messages into the system rows.
        break;
    }
  }

  const user = totals.get("user") ?? { tokens: 0, count: 0 };
  const bash = totals.get("bash");
  const summary = totals.get("summary");
  const assistantTextTokens = estimateCharacters(assistantTextChars);
  const assistantThinkingTokens = estimateCharacters(assistantThinkingChars);
  const toolCallTokens = estimateCharacters(toolCallChars);
  const toolResultEntries = sortedByTokens(toolResults);
  const toolResultTotal = sumStats(toolResultEntries);
  const customEntries = sortedByTokens(customMessages);

  const totalTokens =
    user.tokens +
    assistantTextTokens +
    assistantThinkingTokens +
    toolCallTokens +
    toolResultTotal.tokens +
    sumStats(customEntries).tokens +
    (bash?.tokens ?? 0) +
    (summary?.tokens ?? 0);

  const rows: Row[] = [
    {
      indent: 0,
      label: "Messages",
      tokens: totalTokens,
      note: `${messages.length} in context`,
    },
    { indent: 1, label: "user", tokens: user.tokens, note: `${user.count}` },
    { indent: 1, label: "assistant text", tokens: assistantTextTokens },
    { indent: 1, label: "assistant thinking", tokens: assistantThinkingTokens },
    { indent: 1, label: "tool calls", tokens: toolCallTokens },
    {
      indent: 1,
      label: "tool results",
      tokens: toolResultTotal.tokens,
      note: `${toolResultTotal.count}`,
    },
    ...toolResultEntries.map(([name, stats]) => ({
      indent: 2,
      label: name,
      tokens: stats.tokens,
      note: `${stats.count}`,
    })),
    ...customEntries.map(([customType, stats]) => ({
      indent: 1,
      label: `extension: ${customType}`,
      tokens: stats.tokens,
      note: `${stats.count}`,
    })),
  ];
  if (bash) {
    rows.push({
      indent: 1,
      label: "bash executions",
      tokens: bash.tokens,
      note: `${bash.count}`,
    });
  }
  if (summary) {
    rows.push({
      indent: 1,
      label: "compaction/branch summaries",
      tokens: summary.tokens,
      note: `${summary.count}`,
    });
  }
  return rows;
}

interface Stats {
  tokens: number;
  count: number;
}

function tally<Key>(map: Map<Key, Stats>, key: Key, tokens: number): void {
  const stats = map.get(key) ?? { tokens: 0, count: 0 };
  stats.tokens += tokens;
  stats.count += 1;
  map.set(key, stats);
}

function sortedByTokens(map: ReadonlyMap<string, Stats>): [string, Stats][] {
  return [...map.entries()].sort((a, b) => b[1].tokens - a[1].tokens);
}

function sumStats(entries: readonly [string, Stats][]): Stats {
  const total: Stats = { tokens: 0, count: 0 };
  for (const [, stats] of entries) {
    total.tokens += stats.tokens;
    total.count += stats.count;
  }
  return total;
}

function renderRows(rows: readonly Row[], contextWindow: number | undefined): string[] {
  const labelWidth = Math.max(
    ...rows.map((row) => row.indent * 2 + row.label.length),
  );
  const tokenWidth = Math.max(
    ...rows.map((row) => formatTokens(row.tokens).length),
  );
  return rows.map((row) => {
    let line =
      "  ".repeat(row.indent) +
      row.label.padEnd(labelWidth - row.indent * 2) +
      "  " +
      formatTokens(row.tokens).padStart(tokenWidth);
    if (row.indent === 0 && contextWindow) {
      line += `  ${percentOf(row.tokens, contextWindow).toFixed(1).padStart(PERCENT_COLUMN_WIDTH)}%`;
    }
    if (row.note) {
      line += `  (${row.note})`;
    }
    return line;
  });
}

// Wide enough for "100.0" with one decimal.
const PERCENT_COLUMN_WIDTH = 5;

// Half of an 80-column terminal, leaving room for the percentage.
const USAGE_BAR_WIDTH = 40;

function usageBar(used: number, total: number): string {
  const filled = Math.min(USAGE_BAR_WIDTH, Math.round((used / total) * USAGE_BAR_WIDTH));
  return `[${"█".repeat(filled)}${"░".repeat(USAGE_BAR_WIDTH - filled)}] ${percentOf(used, total).toFixed(1)}%`;
}

function percentOf(part: number, whole: number): number {
  // eslint-disable-next-line @typescript-eslint/no-magic-numbers -- the conversion to percent is the point of this helper
  return (part / whole) * 100;
}

interface Row {
  indent: number;
  label: string;
  tokens: number;
  note?: string;
}

// A rough average for English text and code; the report only compares sizes.
const CHARACTERS_PER_TOKEN = 4;

function estimateText(text: string): number {
  return estimateCharacters(text.length);
}

function estimateCharacters(characters: number): number {
  return Math.ceil(characters / CHARACTERS_PER_TOKEN);
}

function formatTokens(tokens: number): string {
  return tokens.toLocaleString("en-US");
}
