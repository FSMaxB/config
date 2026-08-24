import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("print-system-prompt", {
    description: "Show or write the current system prompt",
    handler: async (args, context) => {
      const prompt = context.getSystemPrompt();
      const outputPath = args.trim();

      if (outputPath) {
        writeFileSync(outputPath, prompt);
        context.ui.notify(`Wrote system prompt to ${outputPath}`, "info");
        return;
      }

      await context.ui.editor("Current system prompt", prompt);
    },
  });
}
