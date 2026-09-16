import { basename } from "node:path";
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
    case "zellij": {
      // A stack is only visible from a tiled pane. Called from a floating
      // overlay, the stacked pane opens hidden behind whatever is stacked
      // there and the review looks like it never opened — split instead.
      const placement = (await callerPaneIsFloating(pi, signal))
        ? ["--direction", "right"]
        : ["--stacked"];
      // Without --near-current-pane zellij opens beside whatever is focused,
      // which is the tab the user is looking at rather than the pane pi runs
      // in — the review would land in someone else's tab.
      await run(
        pi,
        "zellij",
        [
          "run",
          "--close-on-exit",
          "--near-current-pane",
          "--name",
          "tuicr",
          ...placement,
          "--cwd",
          cwd,
          "--",
          ...command,
        ],
        signal,
      );
      return { multiplexer, id: "" };
    }
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

// zellij's layout dump groups floating panes under `floating_panes {` and
// carries no pane ids, so the caller pane can only be recognised by its
// command. That command is not this process — pi sits several processes below
// the pane's own — so every ancestor is tried. Detection is best effort: on any
// failure the pane opens stacked, as it always did.
async function callerPaneIsFloating(
  pi: ExtensionAPI,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  try {
    const floating = floatingPaneCommands(
      await run(pi, "zellij", ["action", "dump-layout"], signal),
    );
    if (floating.size === 0) return false;
    const ancestors = await callerCommands(pi, signal);
    return ancestors.some((ancestor) => floating.has(ancestor));
  } catch {
    return false;
  }
}

// Commands of the floating panes in the focused tab, by basename. Only that
// tab: a floating pane in some other tab says nothing about where the caller
// sits.
export function floatingPaneCommands(layout: string): Set<string> {
  const commands = new Set<string>();
  let depth = 0;
  let tabDepth: number | undefined;
  let floatingDepth: number | undefined;

  for (const line of layout.split("\n")) {
    if (/^\s*tab[\s{]/.test(line)) tabDepth = line.includes("focus=true") ? depth : undefined;
    else if (tabDepth !== undefined && /^\s*floating_panes\s*\{/.test(line)) floatingDepth = depth;
    else if (floatingDepth !== undefined) {
      const command = /\bcommand="([^"]*)"/.exec(line)?.[1];
      if (command) commands.add(basename(command));
    }

    depth += braceDelta(line);
    if (floatingDepth !== undefined && depth <= floatingDepth) floatingDepth = undefined;
    if (tabDepth !== undefined && depth <= tabDepth) tabDepth = undefined;
  }
  return commands;
}

// Quoted values carry braces of their own: a node like
// `pane command="bash" { args "-c" "f() { :; }" }` would otherwise unbalance
// the nesting for every line that follows.
function braceDelta(line: string): number {
  const unquoted = line.replace(/"(?:[^"\\]|\\.)*"/g, "");
  return count(unquoted, "{") - count(unquoted, "}");
}

function count(haystack: string, character: string): number {
  let total = 0;
  for (const found of haystack) if (found === character) total += 1;
  return total;
}

// Commands of this process and its ancestors, innermost first, by basename.
// macOS has no /proc, so the ancestry is walked over a single ps snapshot.
// Shells are dropped: every pane has one, so matching on a shell would call any
// caller floating as soon as some floating pane runs one.
async function callerCommands(
  pi: ExtensionAPI,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const shells = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh"]);
  const snapshot = await run(pi, "ps", ["-axo", "pid=,ppid=,comm="], signal);
  const processes = new Map<number, { parent: number; command: string }>();
  for (const line of snapshot.split("\n")) {
    const fields = /^\s*(\d+)\s+(\d+)\s+(\S.*?)\s*$/.exec(line);
    if (!fields) continue;
    const [, pid, parent, command] = fields;
    processes.set(Number(pid), { parent: Number(parent), command: basename(command) });
  }

  const commands: string[] = [];
  let pid = process.pid;
  while (pid > 1) {
    const ancestor = processes.get(pid);
    if (!ancestor) break;
    if (!shells.has(ancestor.command)) commands.push(ancestor.command);
    pid = ancestor.parent;
  }
  return commands;
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
