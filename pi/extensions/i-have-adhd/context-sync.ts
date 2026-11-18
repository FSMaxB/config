export const ContextChange = {
  None: "none",
  InjectRules: "inject-rules",
  DisableRules: "disable-rules",
} as const;
export type ContextChange = (typeof ContextChange)[keyof typeof ContextChange];

export function requiredContextChange(
  mode: "enabled" | "disabled",
  rules: "in-context" | "missing",
): ContextChange {
  if (mode === "enabled" && rules === "missing") return ContextChange.InjectRules;
  if (mode === "disabled" && rules === "in-context") return ContextChange.DisableRules;
  return ContextChange.None;
}
