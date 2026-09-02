import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execChecked } from "./exec.ts";

export type Multiplexer = "tmux" | "zellij" | "cmux" | "herdr";

// tmux/zellij panes have no id we need later ("" for zellij); cmux stores the
// surface ref, herdr the pane id used to close the pane after tuicr exits.
export interface PaneHandle {
  multiplexer: Multiplexer;
  id: string;
}

const TIMEOUT = 15_000;

// tmux or zellij running inside cmux/herdr is the innermost multiplexer, so the
// terminal multiplexers are checked first.
export function detectMultiplexer(
  env: NodeJS.ProcessEnv = process.env,
): Multiplexer | undefined {
  if (env.TMUX) return "tmux";
  if (env.ZELLIJ) return "zellij";
  if (env.HERDR_ENV === "1") return "herdr";
  if (env.CMUX_WORKSPACE_ID) return "cmux";
  return undefined;
}

export async function openPane(
  pi: ExtensionAPI,
  multiplexer: Multiplexer,
  cwd: string,
  command: string[],
  signal?: AbortSignal,
): Promise<PaneHandle> {
  const shellCommand = command.map(shellQuote).join(" ");
  switch (multiplexer) {
    case "tmux": {
      const paneId = (
        await run(
          pi,
          "tmux",
          [
            "split-window",
            "-d",
            "-P",
            "-F",
            "#{pane_id}",
            "-b",
            "-l",
            "80%",
            "-c",
            cwd,
            shellCommand,
          ],
          signal,
        )
      ).trim();
      await run(pi, "tmux", ["select-pane", "-t", paneId], signal);
      return { multiplexer, id: paneId };
    }
    case "zellij":
      await run(
        pi,
        "zellij",
        [
          "run",
          "--close-on-exit",
          "--name",
          "tuicr",
          "--stacked",
          "--cwd",
          cwd,
          "--",
          ...command,
        ],
        signal,
      );
      return { multiplexer, id: "" };
    case "cmux": {
      const created = await run(
        pi,
        "cmux",
        ["new-pane", "--type", "terminal", "--direction", "right", "--focus", "true"],
        signal,
      );
      const surface = /surface:\d+/.exec(created)?.[0];
      if (!surface)
        throw new Error(`cmux did not report a surface id: ${created.trim()}`);
      await run(
        pi,
        "cmux",
        [
          "send",
          "--surface",
          surface,
          `cd ${shellQuote(cwd)} && exec ${shellCommand}\n`,
        ],
        signal,
      );
      return { multiplexer, id: surface };
    }
    case "herdr": {
      const split = await run(
        pi,
        "herdr",
        ["pane", "split", "--current", "--direction", "right", "--cwd", cwd, "--focus"],
        signal,
      );
      const paneId = herdrPaneId(split);
      // herdr injects the string into the pane's interactive shell, which may be
      // fish; wrapping in bash -c keeps quoting identical across shells.
      await run(
        pi,
        "herdr",
        [
          "pane",
          "run",
          paneId,
          `bash -c ${shellQuote(`cd ${shellQuote(cwd)} && exec ${shellCommand}`)}`,
        ],
        signal,
      );
      return { multiplexer, id: paneId };
    }
  }
}

// Only herdr leaves an empty shell behind once tuicr exits; the other
// multiplexers close the pane with the process.
export async function closePane(pi: ExtensionAPI, pane: PaneHandle): Promise<void> {
  if (pane.multiplexer !== "herdr") return;
  await run(pi, "herdr", ["pane", "close", pane.id], undefined);
}

function herdrPaneId(json: string): string {
  const parsed = JSON.parse(json) as { result?: { pane?: { pane_id?: string } } };
  const paneId = parsed.result?.pane?.pane_id;
  if (!paneId) throw new Error(`herdr did not report a pane id: ${json.trim()}`);
  return paneId;
}

function run(
  pi: ExtensionAPI,
  command: string,
  args: string[],
  signal: AbortSignal | undefined,
): Promise<string> {
  return execChecked(pi, command, args, { signal, timeout: TIMEOUT });
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
