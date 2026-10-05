export const SubmissionAction = {
  ApproveSuggested: "approve-suggested",
  Approve: "approve",
  ImplementDifferent: "implement-different",
  Refine: "refine",
  Stay: "stay",
} as const;
export type SubmissionAction = (typeof SubmissionAction)[keyof typeof SubmissionAction];

export const APPROVE = "Approve — leave plan mode";
export const APPROVE_CURRENT = "Approve — implement with current model";
export const IMPLEMENT_DIFFERENT = "Implement with different model";
export const REFINE = "Refine — send feedback";
export const STAY = "Stay in plan mode";

export function submissionOptions(suggestedModel: string | undefined): string[] {
  return [
    ...(suggestedModel ? [approveSuggestedLabel(suggestedModel)] : []),
    suggestedModel ? APPROVE_CURRENT : APPROVE,
    IMPLEMENT_DIFFERENT,
    REFINE,
    STAY,
  ];
}

// Anything that is not an offered option, a dismissed dialog included, keeps plan mode on.
export function submissionAction(choice: string | undefined, suggestedModel: string | undefined): SubmissionAction {
  if (choice === undefined || !submissionOptions(suggestedModel).includes(choice)) return SubmissionAction.Stay;
  if (suggestedModel && choice === approveSuggestedLabel(suggestedModel)) return SubmissionAction.ApproveSuggested;
  if (choice === APPROVE || choice === APPROVE_CURRENT) return SubmissionAction.Approve;
  if (choice === IMPLEMENT_DIFFERENT) return SubmissionAction.ImplementDifferent;
  if (choice === REFINE) return SubmissionAction.Refine;
  return SubmissionAction.Stay;
}

function approveSuggestedLabel(suggestedModel: string): string {
  return `Approve — implement with ${suggestedModel} (suggested)`;
}
