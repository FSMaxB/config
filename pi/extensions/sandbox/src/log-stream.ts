export interface LogStreamState {
  partialLine: string;
  pendingViolation: string | undefined;
}

export interface LogStreamViolation {
  line: string;
  encodedCommand: string;
}

export const INITIAL_LOG_STREAM_STATE: LogStreamState = { partialLine: "", pendingViolation: undefined };

// In `log stream --style compact` a violation is two lines: the kernel's `... Sandbox: bash(1) deny(1) <op> <path>`
// line, then the `CMD64_<base64 command key>_END_<suffix>` tag srt appends through `(with message ...)`. One stdout
// chunk can hold many such pairs, and a line or a pair can straddle chunks, so state carries over between chunks.
export function parseLogStreamChunk(state: LogStreamState, chunk: string): { state: LogStreamState; violations: LogStreamViolation[] } {
  const lines = (state.partialLine + chunk).split("\n");
  const partialLine = lines.pop() ?? "";
  let pendingViolation = state.pendingViolation;
  const violations: LogStreamViolation[] = [];
  for (const line of lines) {
    const sandboxMessage = SANDBOX_MESSAGE.exec(line)?.[1];
    if (sandboxMessage !== undefined) {
      pendingViolation = sandboxMessage.includes("deny") ? sanitizeViolationText(sandboxMessage) : undefined;
      continue;
    }
    const encodedCommand = COMMAND_TAG.exec(line)?.[1];
    if (encodedCommand === undefined || pendingViolation === undefined) continue;
    violations.push({ line: pendingViolation, encodedCommand });
    pendingViolation = undefined;
  }
  return { state: { partialLine, pendingViolation }, violations };
}

const SANDBOX_MESSAGE = /Sandbox:\s+(.+)$/;
const COMMAND_TAG = /^CMD64_(.+?)_END/;
// Copied from srt's sandbox-violation-store.js (not exported): violation text reaches the model inside a
// <sandbox_violations> block, so control and bidi characters and angle brackets must not survive.
const DISPLAY_UNSAFE_CHARACTERS = /[\x00-\x1f\x7f-\x9f\u00ad\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]+/gu;

function sanitizeViolationText(text: string): string {
  return text.replace(DISPLAY_UNSAFE_CHARACTERS, " ").replace(/[<>]/g, "").trim();
}
