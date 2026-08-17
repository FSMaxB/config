import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

// Pi persists every model switch (selector, /model, cycling) to settings.json
// as the new default. Neutering the setter keeps switches session-local;
// /default-model persists explicitly. Extensions share the host's module
// instance, so this prototype patch reaches the live settings manager. The
// original is stashed on the prototype so /reload doesn't stack patches.
const ORIGINAL_SETTER = Symbol.for("config.default-model.original-setter");
const prototype = SettingsManager.prototype as Record<PropertyKey, any>;
if (!prototype[ORIGINAL_SETTER]) {
  prototype[ORIGINAL_SETTER] = prototype.setDefaultModelAndProvider;
  prototype.setDefaultModelAndProvider = () => {};
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("default-model", {
    description: "Persist the current model as the default model",
    handler: async (_args, context) => {
      const model = context.model;
      if (!model) {
        context.ui.notify("No model selected", "error");
        return;
      }

      // The session's settings manager is not reachable from extensions, so
      // persist through a fresh one: same lock, same merge-only write path.
      const settings = SettingsManager.create(context.cwd);
      prototype[ORIGINAL_SETTER].call(settings, model.provider, model.id);
      await settings.flush();

      const errors = settings.drainErrors();
      if (errors.length > 0) {
        context.ui.notify(
          `Failed to save default model: ${errors[0].error.message}`,
          "error",
        );
        return;
      }
      context.ui.notify(`Default model: ${model.provider}/${model.id}`, "info");
    },
  });
}
