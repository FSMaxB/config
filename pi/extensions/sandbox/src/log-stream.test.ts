import assert from "node:assert/strict";
import test from "node:test";
import { INITIAL_LOG_STREAM_STATE, parseLogStreamChunk } from "./log-stream.ts";

test("a chunk with several violation pairs yields every one of them", () => {
  // arrange
  const chunk = [1, 2, 3].map((index) => violationPair(index)).join("");

  // act
  const { violations } = parseLogStreamChunk(INITIAL_LOG_STREAM_STATE, chunk);

  // assert
  assert.deepEqual(violations, [1, 2, 3].map((index) => ({
    line: `bash(41718) deny(1) file-write-create /Users/maxbruckner/srt-burst-${index}`,
    encodedCommand: ENCODED_COMMAND,
  })));
});

test("a pair split mid-line and between the violation and its tag still yields one violation", () => {
  // arrange
  const whole = violationPair(1);
  const violationEnd = whole.indexOf("\nCMD64_") + 1;
  const chunks = [whole.slice(0, 40), whole.slice(40, violationEnd), whole.slice(violationEnd, violationEnd + 10), whole.slice(violationEnd + 10)];

  // act
  let state = INITIAL_LOG_STREAM_STATE;
  const violations = chunks.flatMap((chunk) => {
    const parsed = parseLogStreamChunk(state, chunk);
    state = parsed.state;
    return parsed.violations;
  });

  // assert
  assert.deepEqual(violations, [{ line: "bash(41718) deny(1) file-write-create /Users/maxbruckner/srt-burst-1", encodedCommand: ENCODED_COMMAND }]);
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
  const { violations } = parseLogStreamChunk(INITIAL_LOG_STREAM_STATE, chunk);

  // assert
  assert.deepEqual(violations, []);
});

test("angle brackets and control characters in the path do not survive", () => {
  // arrange
  const chunk = "2026-11-12 12:57:43.498 E  kernel[0:800e4] (Sandbox) Sandbox: bash(1) deny(1) file-write-create /tmp/<a>\u0007b\n" +
    `CMD64_${ENCODED_COMMAND}_END__oeiv48gas_SBX\n`;

  // act
  const { violations } = parseLogStreamChunk(INITIAL_LOG_STREAM_STATE, chunk);

  // assert
  assert.deepEqual(violations.map(({ line }) => line), ["bash(1) deny(1) file-write-create /tmp/a b"]);
});

const ENCODED_COMMAND = "YThhYzM0MmItZTQ3MS00Mzc2LWE3ODYtOGZiMjMyMzM2OTY2";

function violationPair(index: number): string {
  return `2026-11-12 12:57:43.498 E  kernel[0:800e4] (Sandbox) Sandbox: bash(41718) deny(1) file-write-create /Users/maxbruckner/srt-burst-${index}\n` +
    `CMD64_${ENCODED_COMMAND}_END__oeiv48gas_SBX\n`;
}
