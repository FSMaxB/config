import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_CONFIG,
  describeState,
  isThinkingMode,
  parseConfig,
  rewriteForeignThinking,
  type ThinkingConfig,
  type ThinkingMode,
} from "./policy.ts";

const USAGE = "Usage: /foreign-thinking [drop|text|keep|reset]";

export default function foreignThinkingExtension(pi: ExtensionAPI) {
  let config: ThinkingConfig = DEFAULT_CONFIG;
  // Pi re-runs extension factories for every new session, so the override ends with the session.
  let override: ThinkingMode | undefined;

  pi.on("session_start", async (_event, context) => {
    const parsed = parseConfig(pi.getSettings());
    config = parsed.config;
    for (const problem of parsed.problems) context.ui.notify(`foreign-thinking: ${problem}`, "warning");
  });

  pi.on("context", async (event, context) => {
    const model = context.model;
    if (!model) return;
    return { messages: rewriteForeignThinking(event.messages, model, config, override) };
  });

  pi.registerCommand("foreign-thinking", {
    description: "Show or override for this session how thinking from other models is sent",
    handler: async (args, context) => {
      const argument = args.trim().toLowerCase();
      if (argument === "") {
        context.ui.notify(describeState(config, override), "info");
        return;
      }
      if (argument === "reset") {
        override = undefined;
        context.ui.notify("foreign-thinking: session override cleared", "info");
        return;
      }
      if (!isThinkingMode(argument)) {
        context.ui.notify(USAGE, "warning");
        return;
      }
      override = argument;
      context.ui.notify(`foreign-thinking: ${argument} for every other model in this session (rules ignored)`, "info");
    },
  });
}
