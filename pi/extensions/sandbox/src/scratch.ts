import { fileURLToPath } from "node:url";
import type { BashSpawnContext } from "@earendil-works/pi-coding-agent";
import { shellQuote } from "../../lib/panes.ts";
import { sessionTemporaryDirectory } from "../../lib/session-temporary-directory.ts";

// Temp-file writers land in the session's scratch directory, which the path rules let bash and the file
// tools write, instead of srt's /tmp/claude, which every session shares.
export function withSessionScratch(context: BashSpawnContext, platform: NodeJS.Platform): BashSpawnContext {
  const directory = sessionScratchDirectory(context.env);
  if (!directory) return context;
  const env: NodeJS.ProcessEnv = { ...context.env, TMPDIR: directory };
  if (platform === "darwin") env.PATH = `${mktempShimDirectory()}:${env.PATH ?? ""}`;
  return { ...context, env };
}

// srt's `env` wrapper sets TMPDIR=/tmp/claude after the inherited variables, so only the command itself can
// override it. One line, so bash's error line numbers still match the agent's command.
export function exportSessionScratch(command: string, environment: NodeJS.ProcessEnv | undefined): string {
  const directory = environment ? sessionScratchDirectory(environment) : undefined;
  if (!directory) return command;
  return `export TMPDIR=${shellQuote(directory)}; ${command}`;
}

// macOS mktemp ignores TMPDIR; the shim in this directory passes it as -p.
export function mktempShimDirectory(): string {
  return fileURLToPath(new URL("../bin", import.meta.url));
}

// pi exposes the session id as PI_SESSION_ID to every bash call; subagent children carry the parent's
// directory in PI_SESSION_TEMP_DIR, which sessionTemporaryDirectory prefers.
function sessionScratchDirectory(environment: NodeJS.ProcessEnv): string | undefined {
  const sessionId = environment.PI_SESSION_ID;
  return sessionId ? sessionTemporaryDirectory(sessionId, environment) : undefined;
}
