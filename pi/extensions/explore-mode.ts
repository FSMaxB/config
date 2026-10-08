import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MODE_IDENTITIES } from "./lib/agent-mode.ts";
import { registerRestrictedMode } from "./lib/restricted-mode.ts";

// Explore mode is plan mode without the planning workflow: read-only by default, its own grant
// memory, nothing to submit. The shared engine does the work; this file only names the mode.
export default function (pi: ExtensionAPI) {
  const explore = registerRestrictedMode(pi, {
    identity: MODE_IDENTITIES.exploring,
    requestedAtStartup: () => true,
  });

  pi.registerFlag("explore", {
    description: "Start in explore mode (read-only codebase exploration; tools that change things need approval)",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("explore", {
    description:
      "Toggle explore mode, review decisions with `grants`, or add a path rule with `allow <glob>` / `deny <glob>`",
    getArgumentCompletions: explore.completions,
    handler: async (args, context) => {
      const argument = args.trim();
      if (await explore.handleCommand(argument, context)) return;
      context.ui.notify(
        `Unknown argument "${argument}". Use /explore to toggle, /explore grants to review, or /explore allow|deny <glob> to add a path rule.`,
        "error",
      );
    },
  });
}
