import { basename } from "node:path";
import type { ProfileTriggers } from "./profiles.ts";

export type TriggerMatch = { kind: "command"; command: string } | { kind: "pattern"; pattern: string };

export function matchTrigger(command: string, triggers: ProfileTriggers): TriggerMatch | undefined {
  const names = commandNames(command);
  const byCommand = triggers.commands.find((candidate) => names.includes(candidate));
  if (byCommand !== undefined) return { kind: "command", command: byCommand };
  const byPattern = triggers.patterns.find((pattern) => new RegExp(pattern).test(command));
  return byPattern === undefined ? undefined : { kind: "pattern", pattern: byPattern };
}

const SEGMENT_SEPARATORS = /\|\||&&|\$\(|[;&|\n()`]/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PREFIX_WORDS = new Set(["env", "exec", "command", "builtin", "time", "nohup", "then", "do", "else", "if", "while", "until", "!", "{"]);

// A heuristic, not a shell parser: the program name in command position of each simple command.
export function commandNames(command: string): string[] {
  return command
    .split(SEGMENT_SEPARATORS)
    .map((segment) => programWord(segment.split(/\s+/).filter((word) => word !== "")))
    .filter((name): name is string => name !== undefined);
}

function programWord(words: readonly string[]): string | undefined {
  const word = words.find((candidate) => !ASSIGNMENT.test(candidate) && !PREFIX_WORDS.has(candidate));
  return word === undefined ? undefined : basename(stripQuotes(word));
}

function stripQuotes(word: string): string {
  const quoted = /^(['"])(.*)\1$/.exec(word);
  return quoted ? quoted[2] : word;
}
