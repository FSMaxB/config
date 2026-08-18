import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ExecCheckedOptions {
  signal?: AbortSignal;
  timeout: number;
  cwd?: string;
}

export async function execChecked(
  pi: ExtensionAPI,
  command: string,
  args: string[],
  options: ExecCheckedOptions,
): Promise<string> {
  const { stdout, stderr, code, killed } = await pi.exec(command, args, options);
  const invocation = `${command} ${args.join(" ")}`;

  if (killed)
    throw new Error(`${invocation} timed out after ${options.timeout / 1000}s.`);
  if (code !== 0)
    throw new Error(
      `${invocation} failed with exit ${code}: ${stderr.trim() || stdout.trim()}`,
    );
  return stdout || stderr;
}
