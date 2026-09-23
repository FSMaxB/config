import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execChecked } from "./exec.ts";

export type Multiplexer = "tmux" | "zellij";

const TIMEOUT = 15_000;

export function detectMultiplexer(
  env: NodeJS.ProcessEnv = process.env,
): Multiplexer | undefined {
  if (env.TMUX) return "tmux";
  if (env.ZELLIJ) return "zellij";
  return undefined;
}

export async function openPane(
  pi: ExtensionAPI,
  multiplexer: Multiplexer,
  cwd: string,
  command: string[],
  signal?: AbortSignal,
): Promise<void> {
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
            command.map(shellQuote).join(" "),
          ],
          signal,
        )
      ).trim();
      await run(pi, "tmux", ["select-pane", "-t", paneId], signal);
      return;
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
      return;
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
