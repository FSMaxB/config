type BranchEntry = Readonly<{
  type: string;
  message?: Readonly<{ role?: string }>;
}>;

export const ContextChange = {
  None: "none",
  InjectRules: "inject-rules",
  DisableRules: "disable-rules",
} as const;
export type ContextChange = (typeof ContextChange)[keyof typeof ContextChange];

/**
 * Whether nothing has been sent to the model on this branch yet. Until then the
 * mode can still follow the selected model without leaving traces in the context.
 */
export function sessionIsEmpty(entries: readonly BranchEntry[]): boolean {
  return !entries.some(
    (entry) =>
      entry.type === "message" &&
      (entry.message?.role === "user" || entry.message?.role === "assistant"),
  );
}

export function requiredContextChange(
  enabled: boolean,
  rulesInContext: boolean,
): ContextChange {
  if (enabled && !rulesInContext) return ContextChange.InjectRules;
  if (!enabled && rulesInContext) return ContextChange.DisableRules;
  return ContextChange.None;
}
