import { tmpdir } from "node:os";
import { join } from "node:path";

export const TEMPORARY_DIRECTORY_ENV = "PI_SESSION_TEMP_DIR";

// Subagent children run without a session file and get a random session id, so the parent
// hands its own directory down through the environment and the child reuses it.
export function sessionTemporaryDirectory(sessionId: string, environment: NodeJS.ProcessEnv = process.env): string {
  const inherited = environment[TEMPORARY_DIRECTORY_ENV];
  if (inherited) return inherited;
  return join(tmpdir(), "pi-sessions", sessionId.replace(/[^\w.-]+/g, "_"));
}
