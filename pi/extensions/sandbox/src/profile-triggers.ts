import { basename } from "node:path";
import type { ProfileTriggers } from "./profiles.ts";
import { simpleCommands } from "./shell-words.ts";

export function matchTrigger(command: string, triggers: ProfileTriggers): TriggerMatch | undefined {
  const names = commandNames(command);
  const byCommand = triggers.commands.find((candidate) => names.includes(candidate));
  if (byCommand !== undefined) return { kind: "command", command: byCommand };
  const byPattern = triggers.patterns.find((pattern) => new RegExp(pattern).test(command));
  return byPattern === undefined ? undefined : { kind: "pattern", pattern: byPattern };
}

export type TriggerMatch = { kind: "command"; command: string } | { kind: "pattern"; pattern: string };

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Shell keywords that can precede the program of a simple command.
const KEYWORDS = new Set(["!", "{", "if", "then", "elif", "else", "while", "until", "do"]);

/**
 * The programs each simple command runs, including those behind wrappers such as `timeout 60 bazel build`.
 * A heuristic, not a shell parser: aliases, functions, `$CMD` programs and `eval` are not seen.
 */
export function commandNames(command: string): string[] {
  return simpleCommands(command).flatMap((words) => programNames(words));
}

function programNames(words: readonly string[]): string[] {
  const start = words.findIndex((word) => !ASSIGNMENT.test(word) && !KEYWORDS.has(word));
  if (start === -1) return [];
  const name = basename(words[start]);
  const wrapper = WRAPPERS.get(name);
  if (wrapper === undefined) return [name];
  const wrapped = wrappedCommand(words.slice(start + 1), wrapper);
  return [name, ...(wrapper.runs === "shell" ? commandNames(wrapped.join(" ")) : programNames(wrapped))];
}

// Option lists from the macOS, GNU coreutils/findutils and procps-ng usage texts.
const TIMEOUT: Wrapper = { valueOptions: new Set(["-s", "--signal", "-k", "--kill-after"]), operands: 1, runs: "exec" };
const WRAPPERS: ReadonlyMap<string, Wrapper> = new Map<string, Wrapper>([
  ["timeout", TIMEOUT],
  ["gtimeout", TIMEOUT],
  ["watch", { valueOptions: new Set(["-n", "--interval", "-q", "--equexit", "-s", "--shotsdir"]), operands: 0, runs: "shell" }],
  ["nice", { valueOptions: new Set(["-n", "--adjustment"]), operands: 0, runs: "exec" }],
  ["nohup", { valueOptions: new Set(), operands: 0, runs: "exec" }],
  ["time", { valueOptions: new Set(["-o", "-f", "--output", "--format"]), operands: 0, runs: "exec" }],
  ["env", { valueOptions: new Set(["-u", "--unset", "-C", "--chdir", "-P", "-S", "--split-string"]), operands: 0, runs: "exec" }],
  ["exec", { valueOptions: new Set(["-a"]), operands: 0, runs: "exec" }],
  ["command", { valueOptions: new Set(), operands: 0, runs: "exec" }],
  ["builtin", { valueOptions: new Set(), operands: 0, runs: "exec" }],
  ["caffeinate", { valueOptions: new Set(["-t", "-w"]), operands: 0, runs: "exec" }],
  ["stdbuf", { valueOptions: new Set(["-i", "-o", "-e", "--input", "--output", "--error"]), operands: 0, runs: "exec" }],
  [
    "xargs",
    {
      valueOptions: new Set(["-a", "--arg-file", "-d", "--delimiter", "-E", "-I", "-J", "-L", "-n", "--max-args", "-P", "--max-procs", "-R", "-S", "-s", "--max-chars"]),
      operands: 0,
      runs: "exec",
    },
  ],
]);

// The words after the wrapper's options and operands.
function wrappedCommand(words: readonly string[], { valueOptions, operands }: Wrapper): readonly string[] {
  let index = 0;
  while (index < words.length && words[index].startsWith("-") && words[index] !== "-") {
    if (words[index] === "--") return words.slice(index + 1 + operands);
    index += takesNextWord(words[index], valueOptions) ? 2 : 1;
  }
  return words.slice(index + operands);
}

interface Wrapper {
  /** Options that take a value, given as `-n 5`, `-n5`, `--interval 5` or `--interval=5`. */
  valueOptions: ReadonlySet<string>;
  /** Arguments between the options and the command, such as timeout's duration. */
  operands: number;
  /** `exec` wrappers run their arguments as a command; `shell` wrappers join them and run them through `sh -c`. */
  runs: "exec" | "shell";
}

// `-n 5` and `--interval 5` take the next word; `-n5`, `-dn5` and `--interval=5` carry their value.
function takesNextWord(option: string, valueOptions: ReadonlySet<string>): boolean {
  if (option.startsWith("--")) return valueOptions.has(option);
  const letters = Array.from(option.slice(1));
  return letters.findIndex((letter) => valueOptions.has(`-${letter}`)) === letters.length - 1;
}
