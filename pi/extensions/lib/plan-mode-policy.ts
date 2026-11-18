import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
export const SubmissionAction = {
  Approve: "approve",
  Stay: "stay",
} as const;
export type SubmissionAction = (typeof SubmissionAction)[keyof typeof SubmissionAction];

// crit_review submits a plan only after the user approved it in crit, so asking again is redundant.
export const PlanApproval = {
  Pending: "pending",
  Given: "given",
} as const;
export type PlanApproval = (typeof PlanApproval)[keyof typeof PlanApproval];

export const APPROVE = "Approve";
export const STAY = "Stay in plan mode";
export const SUBMISSION_OPTIONS = [APPROVE, STAY];

// Anything but an explicit approval, a dismissed dialog included, keeps plan mode on.
export function submissionAction(choice: string | undefined): SubmissionAction {
  return choice === APPROVE ? SubmissionAction.Approve : SubmissionAction.Stay;
}

// Mirrors pi's own choice when switching models, so the preselected level is the one
// the model would get without this dialog.
// pi's own default when the settings name no level.
const PI_DEFAULT_THINKING_LEVEL: ModelThinkingLevel = "medium";

// pi-ai's MODEL_THINKING_LEVELS, which the package does not export.
const MODEL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ModelThinkingLevel[];

export function parseThinkingLevel(value: string): ModelThinkingLevel | undefined {
  return MODEL_THINKING_LEVELS.find((level) => level === value);
}

export function preferredThinkingLevel(
  modelLabel: string,
  settings: { modelThinkingLevels?: Record<string, string>; defaultThinkingLevel?: string },
): ModelThinkingLevel {
  const configured = settings.modelThinkingLevels?.[modelLabel] ?? settings.defaultThinkingLevel;
  return (configured === undefined ? undefined : parseThinkingLevel(configured)) ?? PI_DEFAULT_THINKING_LEVEL;
}

export function thinkingLevelLabel(level: string, defaultLevel: string, currentLevel: string): string {
  const markers = [
    ...(level === defaultLevel ? ["default"] : []),
    ...(level === currentLevel ? ["current"] : []),
  ];
  return markers.length === 0 ? level : `${level} (${markers.join(", ")})`;
}
