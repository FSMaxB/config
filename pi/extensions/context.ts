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

export default function (pi: ExtensionAPI) {
  pi.registerCommand("context", {
    description: "Show detailed stats on how the context window is used",
    handler: async (_args, context) => {
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
    `Context usage — ${model ? `${model.provider}/${model.id}` : "no model"}`,
    "",
  ];
  if (contextWindow) {
    const percent = (contextTokens / contextWindow) * 100;
    lines.push(usageBar(percent));
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
        tokens: Math.ceil(instructionCharacters / 4),
        note: `${messages.length} system entries`,
      },
    ],
    [
      {
        indent: 0,
        label: "Tool declarations (transcript)",
        tokens: Math.ceil(toolCharacters / 4),
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
    }
  }

  const user = totals.get("user") ?? { tokens: 0, count: 0 };
  const bash = totals.get("bash");
  const summary = totals.get("summary");
  const assistantTextTokens = Math.ceil(assistantTextChars / 4);
  const assistantThinkingTokens = Math.ceil(assistantThinkingChars / 4);
  const toolCallTokens = Math.ceil(toolCallChars / 4);
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

function sortedByTokens(map: Map<string, Stats>): [string, Stats][] {
  return [...map.entries()].sort((a, b) => b[1].tokens - a[1].tokens);
}

function sumStats(entries: [string, Stats][]): Stats {
  return entries.reduce(
    (total, [, stats]) => ({ tokens: total.tokens + stats.tokens, count: total.count + stats.count }),
    { tokens: 0, count: 0 },
  );
}

function renderRows(rows: Row[], contextWindow: number | undefined): string[] {
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
      line += `  ${((row.tokens / contextWindow) * 100).toFixed(1).padStart(5)}%`;
    }
    if (row.note) {
      line += `  (${row.note})`;
    }
    return line;
  });
}

function usageBar(percent: number): string {
  const width = 40;
  const filled = Math.min(width, Math.round((percent / 100) * width));
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${percent.toFixed(1)}%`;
}

interface Row {
  indent: number;
  label: string;
  tokens: number;
  note?: string;
}

function estimateText(text: string): number {
  return Math.ceil(text.length / 4);
}

function formatTokens(tokens: number): string {
  return tokens.toLocaleString("en-US");
}
