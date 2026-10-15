import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  choosesModelOnCommandLine,
  configuredDefaultModel,
  DefaultModelOutcome,
  fallbackWarning,
  isSameModel,
  type ModelReference,
} from "./lib/default-model.ts";
import { isPlanHandoffSession } from "./lib/plan-handoff.ts";

// pi falls back to the first available model without a word when the default model is missing
// or has no auth at startup (findInitialModel step 4). Extension providers like pi-claude can
// register after that choice, so retry the default before warning.
export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (event, context) => {
    if (event.reason !== "startup" && event.reason !== "new") return;
    if (!context.hasUI) return;
    // plan-mode sets the model the user picked for the implementation session.
    if (isPlanHandoffSession(context.sessionManager)) return;
    if (context.sessionManager.getBranch().some((entry) => entry.type === "message")) return;
    if (choosesModelOnCommandLine(process.argv)) return;

    const configured = configuredDefaultModel(pi.getSettings());
    if (!configured) return;
    const fallback = context.model;
    if (isSameModel(fallback, configured)) return;

    const outcome = await restoreDefaultModel(pi, context, configured);
    context.ui.notify(fallbackWarning(configured, fallback, outcome), "warning");
  });
}

async function restoreDefaultModel(
  pi: ExtensionAPI,
  context: ExtensionContext,
  configured: ModelReference,
): Promise<DefaultModelOutcome> {
  await context.modelRegistry.refresh({ allowNetwork: false }).catch(() => undefined);
  const model = context.modelRegistry.find(configured.provider, configured.id);
  if (!model) return DefaultModelOutcome.Missing;
  if (!context.modelRegistry.hasConfiguredAuth(model)) return DefaultModelOutcome.NoAuth;
  const switched = await pi.setModel(model).catch(() => false);
  return switched ? DefaultModelOutcome.Switched : DefaultModelOutcome.SwitchFailed;
}
