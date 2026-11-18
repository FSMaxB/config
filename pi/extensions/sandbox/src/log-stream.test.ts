import assert from "node:assert/strict";
import test from "node:test";
import { INITIAL_LOG_STREAM_STATE, parseLogStreamChunk, SRT_VIOLATIONS } from "./log-stream.ts";
import type { LogStreamFormat } from "./log-stream.ts";

test("a chunk with several violation pairs yields every one of them", () => {
  // arrange
  const chunk = [1, 2, 3].map((index) => violationPair(index)).join("");

  // act
  const { entries } = parseLogStreamChunk(INITIAL_LOG_STREAM_STATE, chunk, SRT_VIOLATIONS);

  // assert
  assert.deepEqual(entries, [1, 2, 3].map((index) => ({
    line: `bash(41718) deny(1) file-write-create /Users/maxbruckner/srt-burst-${index}`,
    tag: ENCODED_COMMAND,
  })));
});

test("a pair split mid-line and between the violation and its tag still yields one violation", () => {
  // arrange
  const whole = violationPair(1);
  const violationEnd = whole.indexOf("\nCMD64_") + 1;
  const chunks = [whole.slice(0, 40), whole.slice(40, violationEnd), whole.slice(violationEnd, violationEnd + 10), whole.slice(violationEnd + 10)];

  // act
  let state = INITIAL_LOG_STREAM_STATE;
  const entries = chunks.flatMap((chunk) => {
    const parsed = parseLogStreamChunk(state, chunk, SRT_VIOLATIONS);
    state = parsed.state;
    return parsed.entries;
  });

  // assert
  assert.deepEqual(entries, [{ line: "bash(41718) deny(1) file-write-create /Users/maxbruckner/srt-burst-1", tag: ENCODED_COMMAND }]);
});

test("headers, allowed operations and tags without a violation yield nothing", () => {
  // arrange
  const chunk = [
    "Filtering the log data using \"eventMessage ENDSWITH \"_SBX\"\"",
    "Timestamp               Ty Process[PID:TID]",
    "2026-11-12 12:57:43.498 E  kernel[0:800e4] (Sandbox) Sandbox: bash(41718) allow file-read-data /tmp/x",
    `CMD64_${ENCODED_COMMAND}_END__oeiv48gas_SBX`,
    `CMD64_${ENCODED_COMMAND}_END__oeiv48gas_SBX`,
    "",
  ].join("\n");

  // act
  const { entries } = parseLogStreamChunk(INITIAL_LOG_STREAM_STATE, chunk, SRT_VIOLATIONS);

  // assert
  assert.deepEqual(entries, []);
});

test("angle brackets and control characters in the path do not survive", () => {
  // arrange
  const chunk = "2026-11-12 12:57:43.498 E  kernel[0:800e4] (Sandbox) Sandbox: bash(1) deny(1) file-write-create /tmp/<a>\u0007b\n" +
    `CMD64_${ENCODED_COMMAND}_END__oeiv48gas_SBX\n`;

  // act
  const { entries } = parseLogStreamChunk(INITIAL_LOG_STREAM_STATE, chunk, SRT_VIOLATIONS);

  // assert
  assert.deepEqual(entries.map(({ line }) => line), ["bash(1) deny(1) file-write-create /tmp/a b"]);
});

test("the allow format keeps allowed operations with the recorder tag and ignores denials", () => {
  // arrange
  const allow: LogStreamFormat = { action: "allow", tag: /^(PIREC_\w+_END)/ };
  const chunk = [
    "2026-11-12 12:57:43.498 E  kernel[0:800e4] (Sandbox) Sandbox: cat(66048) allow file-read-data /private/etc/shells",
    "PIREC_abc123_END",
    "2026-11-12 12:57:43.499 E  kernel[0:800e4] (Sandbox) Sandbox: cat(66048) deny(1) file-read-data /private/etc/other",
    "PIREC_abc123_END",
    "",
  ].join("\n");

  // act
  const { entries } = parseLogStreamChunk(INITIAL_LOG_STREAM_STATE, chunk, allow);

  // assert
  assert.deepEqual(entries, [{ line: "cat(66048) allow file-read-data /private/etc/shells", tag: "PIREC_abc123_END" }]);
});

test("a path that contains deny does not turn an allow line into a denial", () => {
  // arrange
  const chunk = [
    "2026-11-12 12:57:43.498 E  kernel[0:800e4] (Sandbox) Sandbox: cat(7) allow file-read-data /tmp/deny(1)/x",
    `CMD64_${ENCODED_COMMAND}_END__oeiv48gas_SBX`,
    "",
  ].join("\n");

  // act
  const { entries } = parseLogStreamChunk(INITIAL_LOG_STREAM_STATE, chunk, SRT_VIOLATIONS);

  // assert
  assert.deepEqual(entries, []);
});

const ENCODED_COMMAND = "YThhYzM0MmItZTQ3MS00Mzc2LWE3ODYtOGZiMjMyMzM2OTY2";

function violationPair(index: number): string {
  return `2026-11-12 12:57:43.498 E  kernel[0:800e4] (Sandbox) Sandbox: bash(41718) deny(1) file-write-create /Users/maxbruckner/srt-burst-${index}\n` +
    `CMD64_${ENCODED_COMMAND}_END__oeiv48gas_SBX\n`;
}
