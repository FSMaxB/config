export interface LogStreamState {
  partialLine: string;
  pendingLine: string | undefined;
}

export interface LogStreamEntry {
  line: string;
  // The first capture group of the format's tag pattern.
  tag: string;
}

// Which kernel lines to keep and how to read the tag that follows them: srt tags its denials, the recorder tags its allows.
export interface LogStreamFormat {
  action: "deny" | "allow";
  tag: RegExp;
}

export const SRT_VIOLATIONS: LogStreamFormat = { action: "deny", tag: /^CMD64_(.+?)_END/ };

export const INITIAL_LOG_STREAM_STATE: LogStreamState = { partialLine: "", pendingLine: undefined };

// In `log stream --style compact` an entry is two lines: the kernel's `... Sandbox: bash(1) deny(1) <op> <path>`
// line, then the tag appended through `(with message ...)`. One stdout chunk can hold many such pairs, and a line
// or a pair can straddle chunks, so state carries over between chunks.
export function parseLogStreamChunk(state: LogStreamState, chunk: string, format: LogStreamFormat): { state: LogStreamState; entries: LogStreamEntry[] } {
  const lines = (state.partialLine + chunk).split("\n");
  const partialLine = lines.pop() ?? "";
  let pendingLine = state.pendingLine;
  const entries: LogStreamEntry[] = [];
  for (const line of lines) {
    const sandboxMessage = SANDBOX_MESSAGE.exec(line)?.[1];
    if (sandboxMessage !== undefined) {
      pendingLine = ACTION.exec(sandboxMessage)?.[1] === format.action ? sanitizeViolationText(sandboxMessage) : undefined;
      continue;
    }
    const tag = format.tag.exec(line)?.[1];
    if (tag === undefined || pendingLine === undefined) continue;
    entries.push({ line: pendingLine, tag });
    pendingLine = undefined;
  }
  return { state: { partialLine, pendingLine }, entries };
}

const SANDBOX_MESSAGE = /Sandbox:\s+(.+)$/;
// Anchored on the process name and id so a path that contains "deny" cannot be mistaken for the action.
const ACTION = /^.*?\(\d+\)\s+(deny|allow)(?:\(\d+\))?\s/;
// Copied from srt's sandbox-violation-store.js (not exported): violation text reaches the model inside a
// <sandbox_violations> block, so control and bidi characters and angle brackets must not survive.
// eslint-disable-next-line no-control-regex -- the control characters are what this pattern removes
const DISPLAY_UNSAFE_CHARACTERS = /[\x00-\x1f\x7f-\x9f\u00ad\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]+/gu;

function sanitizeViolationText(text: string): string {
  return text.replace(DISPLAY_UNSAFE_CHARACTERS, " ").replace(/[<>]/g, "").trim();
}
