import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { activePathRuleStore } from "./lib/path-permissions.ts";
import { addPathRuleInteractively, managePathRules } from "./lib/path-rule-commands.ts";
import { parsePathsArgument, pathsCompletions } from "./lib/paths-command.ts";

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("paths", {
    description:
      "Review path rules with `grants`, or add one with `allow <glob>` / `deny <glob>`; prefix `execution`, `plan` or `explore` for another mode's rules",
    getArgumentCompletions: pathsCompletions,
    handler: async (commandArguments, context) => {
      const argument = commandArguments.trim();
      const command = parsePathsArgument(argument, activePathRuleStore());
      if (command === undefined) {
        context.ui.notify(`Unknown argument "${argument}". Use /paths [execution|plan|explore] [grants | allow <glob> | deny <glob>].`, "error");
        return;
      }
      if (command.kind === "grants") {
        await managePathRules(command.store, context);
        return;
      }
      await addPathRuleInteractively(command.ruleKind, command.pattern, command.store, `/paths ${command.store}`, context);
    },
  });
}
