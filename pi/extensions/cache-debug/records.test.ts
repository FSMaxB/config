import assert from "node:assert/strict";
import { test } from "node:test";
import { fingerprintPayload } from "./fingerprint.ts";
import { filterHeaders, Outcome, RequestTracker, type LogRecord } from "./records.ts";

const identity = { sessionId: "s", provider: "mistral", model: "large", api: "mistral-conversations" };
const usage = { input: 10, output: 5, cacheRead: 100, cacheWrite: 0, cost: { total: 1 }, totalTokens: 115 };

function arrange() {
  const records: LogRecord[] = [];
  return { records, tracker: new RequestTracker((record) => records.push(record)) };
}

test("a request, its response and its message emit one completed record", () => {
  // arrange
  const { records, tracker } = arrange();
  const payload = fingerprintPayload({ messages: [{ role: "user", content: "a" }] });

  // act
  tracker.request({ ...identity, at: new Date(1000), payload });
  tracker.response(200, { "x-request-id": "r1", "set-cookie": "secret" });
  tracker.assistantMessage({ ...identity, usage, stopReason: "stop", responseId: "resp", at: new Date(2000) });

  // assert
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    version: 1,
    kind: "request",
    ...identity,
    startedAt: new Date(1000).toISOString(),
    completedAt: new Date(2000).toISOString(),
    payload,
    status: 200,
    responseHeaders: { "x-request-id": "r1" },
    usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 0 },
    stopReason: "stop",
    responseId: "resp",
    outcome: Outcome.Completed,
  });
});

test("a request followed by another request is emitted as superseded", () => {
  // arrange
  const { records, tracker } = arrange();

  // act
  tracker.request({ ...identity, at: new Date(1000) });
  tracker.request({ ...identity, at: new Date(2000) });

  // assert
  assert.deepEqual(records.map((record) => record.kind === "request" && record.outcome), [Outcome.Superseded]);
});

test("a message without a request emits a usage-only record", () => {
  // arrange
  const { records, tracker } = arrange();

  // act
  tracker.assistantMessage({ ...identity, usage, stopReason: "stop", at: new Date(2000) });

  // assert
  const [record] = records;
  assert.ok(record?.kind === "request");
  assert.equal(record.payload, undefined);
  assert.equal(record.outcome, Outcome.Completed);
  assert.equal(record.usage?.cacheRead, 100);
});

test("shutdown flushes a pending request exactly once", () => {
  // arrange
  const { records, tracker } = arrange();
  tracker.request({ ...identity, at: new Date(1000) });

  // act
  tracker.shutdown();
  tracker.shutdown();

  // assert
  assert.deepEqual(records.map((record) => record.kind === "request" && record.outcome), [Outcome.Shutdown]);
});

test("filterHeaders drops credentials and keeps diagnostics", () => {
  // arrange
  const headers = {
    "set-cookie": "a",
    Authorization: "b",
    "x-api-key": "c",
    "x-request-id": "d",
    "x-ratelimit-remaining-tokens": "e",
  };

  // act
  const filtered = filterHeaders(headers);

  // assert
  assert.deepEqual(filtered, { "x-request-id": "d", "x-ratelimit-remaining-tokens": "e" });
});

test("the message provider and model override the request values", () => {
  // arrange
  const { records, tracker } = arrange();
  tracker.request({ ...identity, provider: "virtual", model: "auto", at: new Date(1000) });

  // act
  tracker.assistantMessage({ ...identity, usage, stopReason: "stop", at: new Date(2000) });

  // assert
  const [record] = records;
  assert.ok(record?.kind === "request");
  assert.equal(record.provider, "mistral");
  assert.equal(record.model, "large");
});
