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
const PREFIX_WORDS = new Set(["env", "exec", "command", "builtin", "time", "nohup", "then", "do", "else", "if", "while", "until", "!", "{"]);

// A heuristic, not a shell parser: the program name in command position of each simple command.
export function commandNames(command: string): string[] {
  return simpleCommands(command)
    .map((words) => words.find((word) => !ASSIGNMENT.test(word) && !PREFIX_WORDS.has(word)))
    .filter((word): word is string => word !== undefined)
    .map((word) => basename(word));
}
