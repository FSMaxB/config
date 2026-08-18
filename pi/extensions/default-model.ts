import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

// Pi persists every model switch (selector, /model, cycling) and every
// thinking level switch (selector, /thinking, cycling) to settings.json as
// the new default. Neutering both setters keeps switches session-local;
// /default-model persists both explicitly. Extensions share the host's
// module instance, so this prototype patch reaches the live settings
// manager. The originals are stashed on the prototype so /reload doesn't
// stack patches.
const ORIGINAL_MODEL_SETTER = Symbol.for("config.default-model.original-model-setter");
const ORIGINAL_THINKING_SETTER = Symbol.for(
  "config.default-model.original-thinking-setter",
);
const prototype = SettingsManager.prototype as Record<PropertyKey, any>;
if (!prototype[ORIGINAL_MODEL_SETTER]) {
  prototype[ORIGINAL_MODEL_SETTER] = prototype.setDefaultModelAndProvider;
  prototype.setDefaultModelAndProvider = () => {};
}
if (!prototype[ORIGINAL_THINKING_SETTER]) {
  prototype[ORIGINAL_THINKING_SETTER] = prototype.setDefaultThinkingLevel;
  prototype.setDefaultThinkingLevel = () => {};
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

      const thinkingLevel = pi.getThinkingLevel();

      // The session's settings manager is not reachable from extensions, so
      // persist through a fresh one: same lock, same merge-only write path.
      const settings = SettingsManager.create(context.cwd);
      prototype[ORIGINAL_MODEL_SETTER].call(settings, model.provider, model.id);
      prototype[ORIGINAL_THINKING_SETTER].call(settings, thinkingLevel);
      await settings.flush();

      const errors = settings.drainErrors();
      if (errors.length > 0) {
        context.ui.notify(
          `Failed to save default model: ${errors[0].error.message}`,
          "error",
        );
        return;
      }
      context.ui.notify(
        `Default model: ${model.provider}/${model.id} (thinking: ${thinkingLevel})`,
        "info",
      );
    },
  });
}
