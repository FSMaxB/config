import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MILLISECONDS_PER_SECOND } from "./units.ts";

export async function execChecked(
  pi: ExtensionAPI,
  command: string,
  commandArguments: readonly string[],
  options: ExecCheckedOptions,
): Promise<string> {
  const { stdout, stderr, code, killed, truncated } = await pi.exec(command, [...commandArguments], options);
  const invocation = `${command} ${commandArguments.join(" ")}`;

  if (options.signal?.aborted) throw new Error(`${invocation} was aborted.`);
  if (truncated) throw new Error(`${invocation} was killed: its output exceeded pi.exec's buffer limit.`);
  if (killed)
    throw new Error(`${invocation} timed out after ${options.timeout / MILLISECONDS_PER_SECOND}s.`);
  if (code !== 0)
    throw new Error(
      `${invocation} failed with exit ${code}: ${stderr.trim() || stdout.trim()}`,
    );
  return stdout || stderr;
}

export interface ExecCheckedOptions {
  signal?: AbortSignal;
  timeout: number;
  cwd?: string;
}
