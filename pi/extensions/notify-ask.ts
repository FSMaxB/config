import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { notifyUser } from "./lib/notify.ts";

export default function (pi: ExtensionAPI) {
  pi.on("tool_execution_start", async (event) => {
    switch (event.toolName) {
      case "question":
        notifyUser(pi, "Waiting for your answer");
        break;
      case "submit_plan":
        notifyUser(pi, "Plan submitted for review");
        break;
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!ctx.isIdle()) return;
    notifyUser(pi, "Ready for input");
  });
}
