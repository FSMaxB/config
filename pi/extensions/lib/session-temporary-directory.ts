import { tmpdir } from "node:os";
import { join } from "node:path";

export const TEMPORARY_DIRECTORY_ENV = "PI_SESSION_TEMP_DIR";

// Bash's $TMPDIR points here, and macOS caps unix socket paths at 104 bytes, so the directory name is the
// random tail of the session id rather than the whole id.
const SESSION_ID_SUFFIX_LENGTH = 12;

// Subagent children run without a session file and get a random session id, so the parent
// hands its own directory down through the environment and the child reuses it.
export function sessionTemporaryDirectory(sessionId: string, environment: NodeJS.ProcessEnv = process.env): string {
  const inherited = environment[TEMPORARY_DIRECTORY_ENV];
  if (inherited) return inherited;
  return join(tmpdir(), "pi", sessionId.replace(/[^\w-]+/g, "_").slice(-SESSION_ID_SUFFIX_LENGTH));
}
