import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { PauseGate, type PauseState } from "./gate.ts";

const STATUS_KEY = "pause";
// pi has no extension event for queued user messages, and the input event fires before
// the message is queued, so a held turn polls for it instead.
const MESSAGE_POLL_INTERVAL_MS = 100;

export default function (pi: ExtensionAPI) {
  const gate = new PauseGate();

  pi.registerCommand("pause", {
    description: "Pause the agent after the current turn, or resume it",
    handler: async (_args, context) => {
      if (gate.state === "running" && context.isIdle()) {
        context.ui.notify("Nothing to pause: the agent is idle", "info");
        return;
      }
      gate.toggle();
      showState(context.ui, gate.state);
    },
  });

  // Holding this boundary keeps the run open between a finished tool batch and the next
  // LLM request. pi polls steering messages right after it, so a message typed during the
  // pause goes out with that request. A turn without tool results ends the run (unless a
  // queued message continues it, which resumes anyway), so the pause stays requested
  // until a turn with tool results or the end of the run.
  pi.on("turn_end", async (event, context) => {
    if (gate.state !== "pausing") return;
    if (event.outcome !== "completed" || event.toolResults.length === 0) return;
    if (context.hasPendingMessages()) {
      gate.reset();
      showState(context.ui, gate.state);
      return;
    }
    const held = gate.hold({
      signal: context.signal,
      hasPendingMessages: () => context.hasPendingMessages(),
      pollIntervalMs: MESSAGE_POLL_INTERVAL_MS,
    });
    showState(context.ui, gate.state);
    await held;
    showState(context.ui, gate.state);
  });

  pi.on("agent_settled", async (_event, context) => {
    if (gate.state === "running") return;
    gate.reset();
    showState(context.ui, gate.state);
  });

  pi.on("session_shutdown", async () => gate.reset());
}

function showState(ui: ExtensionUIContext, state: PauseState): void {
  switch (state) {
    case "running":
      ui.setStatus(STATUS_KEY, undefined);
      ui.setWorkingMessage();
      ui.setWorkingIndicator();
      return;
    case "pausing":
      ui.setStatus(STATUS_KEY, ui.theme.fg("warning", "⏸ pausing after this turn"));
      return;
    case "paused":
      ui.setStatus(STATUS_KEY, ui.theme.fg("warning", "⏸ paused"));
      ui.setWorkingMessage("Paused: /pause or a new message resumes");
      ui.setWorkingIndicator({ frames: [ui.theme.fg("warning", "⏸")] });
      return;
  }
}
