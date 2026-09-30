import type { Usage } from "@earendil-works/pi-ai";

export function subagentOutcome(results: readonly SubagentOutcome[]): { isError: boolean; usage: Usage } {
  return {
    isError: results.some(isFailedResult),
    usage: sumUsage(results.map(result => result.nativeUsage)),
  };
}

export function isFailedResult(result: { exitCode: number; stopReason?: string }): boolean {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
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
