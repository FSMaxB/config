import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("tool_execution_start", async (event) => {
    if (event.toolName !== "question") return;
    notify("Pi", "Waiting for your answer");
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!ctx.isIdle()) return;
    notify("Pi", "Ready for input");
  });
}

function notify(title: string, body: string): void {
  const script = `display notification "${body}" with title "${title}" sound name "Glass"`;
  execFile("osascript", ["-e", script], () => {});
}
