export interface ModelReference {
  provider: string;
  id: string;
}

export const DefaultModelOutcome = {
  Missing: "missing",
  NoAuth: "no-auth",
  Switched: "switched",
  SwitchFailed: "switch-failed",
} as const;
export type DefaultModelOutcome = (typeof DefaultModelOutcome)[keyof typeof DefaultModelOutcome];

type DefaultModelSettings = { defaultProvider?: unknown; defaultModel?: unknown };

export function configuredDefaultModel(settings: object): ModelReference | undefined {
  const { defaultProvider, defaultModel } = settings as DefaultModelSettings;
  if (typeof defaultProvider !== "string" || typeof defaultModel !== "string") return undefined;
  return { provider: defaultProvider, id: defaultModel };
}

// pi parses both flags as exact tokens; either one means the user picked the model on purpose.
export function choosesModelOnCommandLine(argv: readonly string[]): boolean {
  return argv.includes("--model") || argv.includes("--models");
}

export function isSameModel(active: ModelReference | undefined, configured: ModelReference): boolean {
  return active?.provider === configured.provider && active.id === configured.id;
}

export function fallbackWarning(
  configured: ModelReference,
  fallback: ModelReference | undefined,
  outcome: DefaultModelOutcome,
): string {
  const configuredLabel = modelLabel(configured);
  const fallbackLabel = fallback ? modelLabel(fallback) : "no model";
  switch (outcome) {
    case DefaultModelOutcome.Missing:
      return `Default model ${configuredLabel} was not found. Using ${fallbackLabel}.`;
    case DefaultModelOutcome.NoAuth:
      return `Default model ${configuredLabel} has no auth configured. Using ${fallbackLabel}.`;
    case DefaultModelOutcome.Switched:
      return `Default model ${configuredLabel} was not ready at startup, so pi picked ${fallbackLabel}. Switched to ${configuredLabel}.`;
    case DefaultModelOutcome.SwitchFailed:
      return `Default model ${configuredLabel} was not ready at startup and switching to it failed. Using ${fallbackLabel}.`;
  }
}

function modelLabel(model: ModelReference): string {
  return `${model.provider}/${model.id}`;
}
