import assert from "node:assert/strict";
import { test } from "node:test";
import { analyze, parseReportArguments, renderReport, ReportVerbosity, Verdict } from "./analysis.ts";
import { fingerprintPayload } from "./fingerprint.ts";
import { MarkerEvent, Outcome, RECORD_VERSION, type LogRecord, type Usage } from "./records.ts";

interface RequestOptions {
  messages: string[];
  at: number;
  usage?: Usage;
  model?: string;
  maxTokens?: number;
  withPayload?: boolean;
}

function request({ messages, at, usage, model = "large", maxTokens = 4096, withPayload = true }: RequestOptions): LogRecord {
  const payload = withPayload ? fingerprintPayload({ model, messages: messages.map((content) => ({ role: "user", content })), maxTokens }) : undefined;
  return {
    version: RECORD_VERSION,
    kind: "request",
    sessionId: "s",
    provider: "mistral",
    model,
    api: "mistral-conversations",
    startedAt: new Date(at).toISOString(),
    completedAt: new Date(at + 1000).toISOString(),
    ...(payload ? { payload } : {}),
    ...(usage ? { usage } : {}),
    outcome: usage ? Outcome.Completed : Outcome.Superseded,
  };
}

function marker(event: MarkerEvent, at: number): LogRecord {
  return { version: RECORD_VERSION, kind: "marker", sessionId: "s", at: new Date(at).toISOString(), event };
}

function usageOf(cacheRead: number, input: number): Usage {
  return { input, output: 10, cacheRead, cacheWrite: 0 };
}

const turn = "x".repeat(1000);

test("a miss on an exact prefix is a provider miss", () => {
  // arrange
  const records = [
    request({ messages: [turn], at: 0, usage: usageOf(0, 20_000) }),
    request({ messages: [turn, turn], at: 10_000, usage: usageOf(19_000, 2_000) }),
    request({ messages: [turn, turn, turn], at: 20_000, usage: usageOf(0, 30_000) }),
  ];

  // act
  const findings = analyze(records);

  // assert
  const third = findings[2];
  assert.equal(third?.verdict, Verdict.ProviderMiss);
  assert.equal(third?.missedTokens, 21_000);
  assert.equal(third?.idleMs, 9_000);
});

test("a changed earlier message is a prefix change with a located offset", () => {
  // arrange
  const changed = "y".repeat(1000);
  const records = [
    request({ messages: [turn, turn, turn, turn], at: 0, usage: usageOf(0, 20_000) }),
    request({ messages: [turn, turn, turn, turn], at: 10_000, usage: usageOf(19_000, 1_000) }),
    request({ messages: [turn, changed, turn, turn, turn], at: 20_000, usage: usageOf(5_000, 20_000) }),
  ];

  // act
  const finding = analyze(records)[2];

  // assert
  assert.equal(finding?.verdict, Verdict.PrefixChanged);
  assert.equal(finding?.firstChange?.index, 1);
  const estimate = finding?.estimatedChangeTokens ?? 0;
  assert.ok(estimate > 3_000 && estimate < 9_000, `estimate ${estimate}`);
});

test("a small drop stays below the noise floor", () => {
  // arrange
  const records = [
    request({ messages: [turn], at: 0, usage: usageOf(0, 20_000) }),
    request({ messages: [turn, turn], at: 10_000, usage: usageOf(19_500, 600) }),
  ];

  // act
  const finding = analyze(records)[1];

  // assert
  assert.equal(finding?.verdict, Verdict.Ok);
});

test("a cache warm between two requests is no-usage and only changes parameters", () => {
  // arrange
  const records = [
    request({ messages: [turn], at: 0, usage: usageOf(0, 20_000) }),
    request({ messages: [turn], at: 10_000, maxTokens: 1 }),
    request({ messages: [turn, turn], at: 20_000, usage: usageOf(0, 30_000) }),
  ];

  // act
  const [, warm, next] = analyze(records);

  // assert
  assert.equal(warm?.verdict, Verdict.NoUsage);
  assert.equal(next?.verdict, Verdict.Ok);
  assert.deepEqual(next?.changedParameters, ["maxTokens"]);
});

test("a cache warm followed by a miss on an exact prefix is a provider miss, not a prefix change", () => {
  // arrange
  const records = [
    request({ messages: [turn], at: 0, usage: usageOf(1_000, 19_000) }),
    request({ messages: [turn], at: 10_000, maxTokens: 1 }),
    request({ messages: [turn, turn], at: 20_000, usage: usageOf(0, 30_000) }),
  ];

  // act
  const finding = analyze(records)[2];

  // assert
  assert.equal(finding?.verdict, Verdict.ProviderMiss);
  assert.deepEqual(finding?.changedParameters, ["maxTokens"]);
});

test("a compaction marker resets the comparison", () => {
  // arrange
  const records = [
    request({ messages: [turn], at: 0, usage: usageOf(0, 20_000) }),
    marker(MarkerEvent.Compaction, 5_000),
    request({ messages: [turn], at: 10_000, usage: usageOf(0, 20_000) }),
  ];

  // act
  const finding = analyze(records)[1];

  // assert
  assert.equal(finding?.verdict, Verdict.First);
});

test("a model change is reported as such", () => {
  // arrange
  const records = [
    request({ messages: [turn], at: 0, usage: usageOf(0, 20_000) }),
    request({ messages: [turn], at: 10_000, usage: usageOf(0, 20_000), model: "small" }),
  ];

  // act
  const finding = analyze(records)[1];

  // assert
  assert.equal(finding?.verdict, Verdict.ModelChanged);
});

test("a miss without a payload is no-payload", () => {
  // arrange
  const records = [
    request({ messages: [], at: 0, usage: usageOf(1_000, 19_000), withPayload: false }),
    request({ messages: [], at: 10_000, usage: usageOf(0, 30_000), withPayload: false }),
  ];

  // act
  const finding = analyze(records)[1];

  // assert
  assert.equal(finding?.verdict, Verdict.NoPayload);
});

test("a provider that never reports cache is never a miss", () => {
  // arrange
  const records = [
    request({ messages: [turn], at: 0, usage: usageOf(0, 20_000) }),
    request({ messages: [turn, turn], at: 10_000, usage: usageOf(0, 30_000) }),
  ];

  // act
  const finding = analyze(records)[1];

  // assert
  assert.equal(finding?.verdict, Verdict.Ok);
});

test("the report lists problems only and arguments parse", () => {
  // arrange
  const records = [
    request({ messages: [turn], at: 0, usage: usageOf(1_000, 19_000) }),
    request({ messages: [turn, turn], at: 10_000, usage: usageOf(20_000, 500) }),
    request({ messages: [turn, turn, turn], at: 20_000, usage: usageOf(0, 30_000) }),
  ];

  // act
  const problems = renderReport(analyze(records), ReportVerbosity.Problems);
  const everything = renderReport(analyze(records), ReportVerbosity.All);
  const parsed = parseReportArguments(["--all", "abc"]);

  // assert
  assert.ok(problems.includes("provider-miss"));
  assert.ok(!problems.includes("  ok"));
  assert.ok(everything.includes("  ok"));
  assert.match(problems.split("\n")[0] ?? "", /^3 requests · 1 misses/);
  assert.deepEqual(parsed, { verbosity: "all", target: "abc" });
  assert.equal(renderReport([], ReportVerbosity.All), "No requests logged.");
});
