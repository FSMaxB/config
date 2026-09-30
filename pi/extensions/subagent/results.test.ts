import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyUsage, finalizedMessageUsage, isFailedResult, subagentOutcome, sumUsage } from "./results.ts";

test("native usage sums token and cost components without double-counting subsets", () => {
  // arrange
  const first = { ...emptyUsage(), input: 10, output: 5, cacheRead: 2, cacheWrite: 3,
    totalTokens: 20, reasoning: 4, cacheWrite1h: 1,
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } };
  const second = { ...emptyUsage(), input: 6, output: 2, totalTokens: 8,
    cost: { input: 0.5, output: 1, cacheRead: 0, cacheWrite: 0, total: 1.5 } };
  // act
  const total = sumUsage([first, undefined, second]);
  // assert
  assert.deepEqual(total, { input: 16, output: 7, cacheRead: 2, cacheWrite: 3,
    totalTokens: 28, reasoning: 4, cacheWrite1h: 1,
    cost: { input: 1.5, output: 3, cacheRead: 3, cacheWrite: 4, total: 11.5 } });
  assert.equal(first.input, 10);
  assert.equal(sumUsage([second]).reasoning, undefined);
  assert.equal(sumUsage([{ ...second, reasoning: 0 }]).reasoning, 0);
});

test("completed child tool calls contribute usage once across event paths", () => {
  // arrange
  const assistant = { role: "assistant", usage: { ...emptyUsage(), input: 2, totalTokens: 2 } };
  const tool = { role: "toolResult", toolCallId: "nested-1", usage: { ...emptyUsage(), output: 3, totalTokens: 3 } };
  const completed = new Set<string>();
  // act
  const assistantUsage = finalizedMessageUsage(assistant, completed);
  const nestedUsage = finalizedMessageUsage(tool, completed);
  completed.add(tool.toolCallId);
  const duplicateUsage = finalizedMessageUsage(tool, completed);
  const ignoredUsage = finalizedMessageUsage({ role: "user", usage: assistant.usage }, completed);
  // assert
  assert.equal(sumUsage([assistantUsage, nestedUsage, duplicateUsage, ignoredUsage]).totalTokens, 5);
  assert.equal(duplicateUsage, undefined);
  assert.equal(ignoredUsage, undefined);
});

test("single and mixed parallel outcomes report failures while retaining successful usage", () => {
  // arrange
  const success = { exitCode: 0, stopReason: "stop", nativeUsage: { ...emptyUsage(), input: 4, totalTokens: 4 } };
  const failure = { exitCode: 1, nativeUsage: emptyUsage() };
  // act
  const single = subagentOutcome([success]);
  const parallel = subagentOutcome([success, failure]);
  const validation = subagentOutcome([failure]);
  // assert
  assert.equal(single.isError, false);
  assert.equal(parallel.isError, true);
  assert.equal(parallel.usage.totalTokens, 4);
  assert.deepEqual(validation, { isError: true, usage: emptyUsage() });
  assert.equal(isFailedResult({ exitCode: 0, stopReason: "error" }), true);
  assert.equal(isFailedResult({ exitCode: 0, stopReason: "aborted" }), true);
  assert.equal(isFailedResult({ exitCode: 0, stopReason: "stop" }), false);
});
