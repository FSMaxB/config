type BranchEntry = Readonly<{
  type: string;
  message?: Readonly<{ role?: string }>;
}>;

/**
 * Whether nothing has been sent to the model on this branch yet. Until then a
 * mode can still follow the selected model without leaving traces in the context.
 */
export function sessionIsEmpty(entries: readonly BranchEntry[]): boolean {
  return !entries.some(
    (entry) =>
      entry.type === "message" &&
      (entry.message?.role === "user" || entry.message?.role === "assistant"),
  );
}
