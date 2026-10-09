export const SubmissionAction = {
  Approve: "approve",
  Stay: "stay",
} as const;
export type SubmissionAction = (typeof SubmissionAction)[keyof typeof SubmissionAction];

export const APPROVE = "Approve";
export const STAY = "Stay in plan mode";
export const SUBMISSION_OPTIONS = [APPROVE, STAY];

// Anything but an explicit approval, a dismissed dialog included, keeps plan mode on.
export function submissionAction(choice: string | undefined): SubmissionAction {
  return choice === APPROVE ? SubmissionAction.Approve : SubmissionAction.Stay;
}

// Mirrors pi's own choice when switching models, so the preselected level is the one
// the model would get without this dialog.
export function preferredThinkingLevel(
  modelLabel: string,
  settings: { modelThinkingLevels?: Record<string, string>; defaultThinkingLevel?: string },
): string {
  return settings.modelThinkingLevels?.[modelLabel] ?? settings.defaultThinkingLevel ?? "medium";
}

export function thinkingLevelLabel(level: string, defaultLevel: string, currentLevel: string): string {
  const markers = [
    ...(level === defaultLevel ? ["default"] : []),
    ...(level === currentLevel ? ["current"] : []),
  ];
  return markers.length === 0 ? level : `${level} (${markers.join(", ")})`;
}
