import type { Usage } from "@earendil-works/pi-ai";

export function subagentOutcome(results: readonly SubagentOutcome[]): { isError: boolean; usage: Usage } {
  return {
    isError: results.some(isFailedResult),
    usage: sumUsage(results.map(result => result.nativeUsage)),
  };
}

// The exit code of a task whose child process has not exited yet.
export const RUNNING_EXIT_CODE = -1;

export function isRunningResult(result: { exitCode: number }): boolean {
  return result.exitCode === RUNNING_EXIT_CODE;
}

export function isFailedResult(result: { exitCode: number; stopReason?: string }): boolean {
  if (isRunningResult(result)) return false;
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

export interface FailureSources {
  errorMessage?: string;
  stderr: string;
  assistantOutput: string;
}

// A failure can leave its cause in any of these, so every distinct one is shown. A single source
// needs no label, which keeps policy rejections (stored in stderr) readable.
export function failureEvidence({ errorMessage, stderr, assistantOutput }: FailureSources): string {
  const sources = [
    ["Error", errorMessage],
    ["stderr", stderr],
    ["Assistant output", assistantOutput],
  ] as const;
  const distinct = new Map<string, string>();
  for (const [label, value] of sources) {
    const text = value?.trim();
    if (text && ![...distinct.values()].includes(text)) distinct.set(label, text);
  }
  if (distinct.size === 0) return "(no output)";
  if (distinct.size === 1) return [...distinct.values()][0];
  return [...distinct].map(([label, text]) => `${label}: ${text}`).join("\n\n");
}

export function truncateTaskOutput(output: string, capBytes: number): string {
  const byteLength = Buffer.byteLength(output, "utf8");
  if (byteLength <= capBytes) return output;

  let truncated = output.slice(0, capBytes);
  while (Buffer.byteLength(truncated, "utf8") > capBytes) {
    truncated = truncated.slice(0, -1);
  }
  // The byte-trimming loop above can stop right after a lone high surrogate.
  if (/[\uD800-\uDBFF]$/.test(truncated)) truncated = truncated.slice(0, -1);
  return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

export function finalizedMessageUsage(
  message: { role: string; usage?: Usage; toolCallId?: string },
  completedToolCalls: ReadonlySet<string>,
): Usage | undefined {
  if (message.role === "assistant") return message.usage;
  if (message.role !== "toolResult" || !message.toolCallId || completedToolCalls.has(message.toolCallId)) return undefined;
  return message.usage;
}

export function sumUsage(usages: Iterable<Usage | undefined>): Usage {
  const total = emptyUsage();
  for (const usage of usages) {
    if (!usage) continue;
    for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
      total[field] += usage[field] ?? 0;
    }
    for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
      total.cost[field] += usage.cost?.[field] ?? 0;
    }
    for (const field of ["reasoning", "cacheWrite1h"] as const) {
      if (usage[field] !== undefined) total[field] = (total[field] ?? 0) + usage[field];
    }
  }
  return total;
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

export interface SubagentOutcome {
  exitCode: number;
  stopReason?: string;
  nativeUsage: Usage;
}
