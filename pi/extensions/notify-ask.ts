import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { notifyUser } from "./lib/notify.ts";

export default function (pi: ExtensionAPI) {
  // Fires around every blocking ctx.ui prompt (select, confirm, input, editor,
  // custom), so it covers the question tool, submit_plan's review prompt,
  // plan-mode permission prompts, and editor-based commands alike. Replaces the
  // earlier tool_execution_start sniff, which only saw question and submit_plan
  // and missed permission/editor prompts entirely.
  pi.on("ui_prompt_start", async () => {
    notifyUser(pi, "Waiting for your input");
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!ctx.isIdle()) return;
    notifyUser(pi, "Ready for input");
  });

  // Spontaneous threshold/overflow compactions can fail and stall the session.
  // Plan-mode's explicit ctx.compact already reports its own errors via onError,
  // so this only surfaces the unplanned ones. Aborts are transient (overflow
  // retries, manual /compact cancellations) and are not worth a notification.
  pi.on("session_compact_failed", async (event) => {
    if (event.aborted) return;
    notifyUser(
      pi,
      event.errorMessage ? `Compaction failed: ${event.errorMessage}` : "Compaction failed",
    );
  });
}
