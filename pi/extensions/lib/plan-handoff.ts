export const PLAN_HANDOFF_ENTRY_TYPE = "plan-handoff";

export interface PlanHandoffEntry {
  planPath: string;
  provider: string;
  modelId: string;
  thinkingLevel: string;
}

// A fresh implementation session is seeded with this entry before session_start fires,
// so the new plan-mode instance knows which model to activate and which plan to kick off.
export function latestPlanHandoffEntry(
  sessionManager: { getEntries(): readonly unknown[] },
): PlanHandoffEntry | undefined {
  const entries = sessionManager.getEntries() as readonly {
    type: string;
    customType?: string;
    data?: unknown;
  }[];
  const entry = entries
    .filter(
      (candidate) =>
        candidate.type === "custom" &&
        candidate.customType === PLAN_HANDOFF_ENTRY_TYPE,
    )
    .pop();
  if (!entry || typeof entry.data !== "object" || entry.data === null)
    return undefined;

  const { planPath, provider, modelId, thinkingLevel } = entry.data as {
    planPath?: unknown;
    provider?: unknown;
    modelId?: unknown;
    thinkingLevel?: unknown;
  };
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
