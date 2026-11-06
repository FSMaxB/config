import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { notifyUser } from "./lib/notify.ts";

export default function (pi: ExtensionAPI) {
  const PROMPT_GRACE_MS = 500;
  // pi nests prompts and reports only the outermost, so one pending timer covers every open prompt.
  let pendingPrompt: ReturnType<typeof setTimeout> | undefined;

  // Fires around every blocking context.ui prompt (select, confirm, input, editor,
  // custom), so it covers the question tool, submit_plan's review prompt,
  // plan-mode permission prompts, and editor-based commands alike. The grace
  // period skips prompts that close right away, such as the sidebar's ui.custom
  // call, which only exists to reach the TUI.
  pi.on("ui_prompt_start", async (event) => {
    clearTimeout(pendingPrompt);
    pendingPrompt = setTimeout(() => {
      pendingPrompt = undefined;
      notifyUser(pi, "Waiting for your input", event.title);
    }, PROMPT_GRACE_MS);
  });

  pi.on("ui_prompt_end", async () => cancelPendingPrompt());
  pi.on("session_shutdown", async () => cancelPendingPrompt());

  // An abort means the user just pressed Escape, so they are already looking at the terminal.
  pi.on("agent_settled", async (event, context) => {
    if (event.aborted || !context.isIdle()) return;
    notifyUser(pi, "Ready for input");
  });

  // Spontaneous threshold/overflow compactions can fail and stall the session.
  // Plan-mode's explicit context.compact already reports its own errors via onError,
  // so this only surfaces the unplanned ones. Aborts are transient (overflow
  // retries, manual /compact cancellations) and are not worth a notification.
  pi.on("session_compact_failed", async (event) => {
    if (event.aborted) return;
    notifyUser(pi, "Compaction failed", event.errorMessage);
  });

  function cancelPendingPrompt(): void {
    clearTimeout(pendingPrompt);
    pendingPrompt = undefined;
  }
}
