import { mkdir } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { setSessionTemporaryDirectory } from "./lib/path-permissions.ts";
import { registerToolWithGuidelines } from "./lib/register-tool.ts";
import { sessionTemporaryDirectory } from "./lib/session-temporary-directory.ts";

export default function (pi: ExtensionAPI) {
  // Registering the directory at session start covers resumed sessions, where the agent
  // already knows the path from history and may use it without calling the tool again.
  pi.on("session_start", async (_event, context) => {
    setSessionTemporaryDirectory(sessionTemporaryDirectory(context.sessionManager.getSessionId()));
  });

  registerToolWithGuidelines(pi, {
    name: "temp_dir",
    label: "Temporary directory",
    description:
      "Return the absolute path of a scratch directory for this session inside the system temp dir, creating it when missing. " +
      "The file tools can read and write there without prompting, in plan mode too. " +
      "Subagents share their parent session's directory.",
    promptSnippet: "Get a session-scoped scratch directory the file tools can read and write",
    promptGuidelines: [
      "Call temp_dir when you need a scratch location instead of writing temporary files into the repository or guessing a path under /tmp.",
    ],
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, context) {
      const path = sessionTemporaryDirectory(context.sessionManager.getSessionId());
      await mkdir(path, { recursive: true });
      setSessionTemporaryDirectory(path);
      return { content: [{ type: "text", text: path }], details: { path } };
    },

    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("temp_dir")), 0, 0);
    },

    renderResult(result, _renderOptions, theme) {
      const details = result.details as { path: string } | undefined;
      return new Text(theme.fg("success", "✓ ") + theme.fg("dim", details?.path ?? ""), 0, 0);
    },
  });
}
