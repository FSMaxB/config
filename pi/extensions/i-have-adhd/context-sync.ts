export const ContextChange = {
  None: "none",
  InjectRules: "inject-rules",
  DisableRules: "disable-rules",
} as const;
export type ContextChange = (typeof ContextChange)[keyof typeof ContextChange];

export function requiredContextChange(
  enabled: boolean,
  rulesInContext: boolean,
): ContextChange {
  if (enabled && !rulesInContext) return ContextChange.InjectRules;
  if (!enabled && rulesInContext) return ContextChange.DisableRules;
  return ContextChange.None;
}
