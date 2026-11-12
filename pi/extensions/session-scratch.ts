import { mkdir } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setSessionTemporaryDirectory } from "./lib/path-permissions.ts";
import { sessionTemporaryDirectory } from "./lib/session-temporary-directory.ts";

// Bash points $TMPDIR at this directory (sandbox/src/scratch.ts) and the path rules allow it, so it has to
// exist before the first command and be registered before the first file tool call.
export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, context) => {
    const directory = sessionTemporaryDirectory(context.sessionManager.getSessionId());
    await mkdir(directory, { recursive: true, mode: 0o700 });
    setSessionTemporaryDirectory(directory);
  });
}
