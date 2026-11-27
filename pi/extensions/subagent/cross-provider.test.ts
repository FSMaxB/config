import assert from "node:assert/strict";
import test from "node:test";
import { Duration } from "../lib/permission-prompt.ts";
import type { PermissionAnswer } from "../lib/permission-prompt.ts";
import { ProviderDecisions, emptyProviderDecisions, parseProviderDecisions, providerList, resolveProviderAnswer, settleProvider } from "./cross-provider.ts";

test("a session deny beats an always allow", () => {
  // arrange
  const session = emptyProviderDecisions().record("openai", { decision: "deny", note: "too slow" });
  const always = emptyProviderDecisions().record("openai", { decision: "allow" });

  // act
  const outcome = settleProvider("openai", { session, always, hasUI: true });

  // assert
  assert.deepEqual(outcome, {
    kind: "deny",
    reason: "The user denied subagents on provider openai for this session. The user's reason: too slow",
  });
});

test("an always allow applies when the session has not decided", () => {
  // arrange
  const always = emptyProviderDecisions().record("openai", { decision: "allow" });

  // act
  const outcome = settleProvider("openai", { session: emptyProviderDecisions(), always, hasUI: true });

  // assert
  assert.deepEqual(outcome, { kind: "allow" });
});

test("without a UI an undecided provider is denied and a decided one still allowed", () => {
  // arrange
  const always = emptyProviderDecisions().record("openai", { decision: "allow" });
  const situation = { session: emptyProviderDecisions(), always, hasUI: false };

  // act
  const undecided = settleProvider("greenpt", situation);
  const decided = settleProvider("openai", situation);

  // assert
  assert.equal(undecided.kind, "deny");
  assert.match(undecided.reason, /no interactive UI/);
  assert.deepEqual(decided, { kind: "allow" });
});

test("an undecided provider with a UI asks", () => {
  // arrange
  const situation = { session: emptyProviderDecisions(), always: emptyProviderDecisions(), hasUI: true };

  // act
  const outcome = settleProvider("openai", situation);

  // assert
  assert.deepEqual(outcome, { kind: "ask" });
});

test("an answer is remembered for as long as its duration says", () => {
  // arrange
  const providers = ["openai"];
  const allowSession: PermissionAnswer<readonly string[]> = { decision: "allow", duration: Duration.Session, scope: providers };
  const allowAlways: PermissionAnswer<readonly string[]> = { decision: "allow", duration: Duration.Always, scope: providers };
  const denyOnce: PermissionAnswer<readonly string[]> = { decision: "deny", duration: Duration.Once, note: "too slow" };

  // act
  const session = resolveProviderAnswer("openai", allowSession);
  const always = resolveProviderAnswer("openai", allowAlways);
  const once = resolveProviderAnswer("openai", denyOnce);

  // assert
  assert.deepEqual(session, { verdict: { kind: "allow" }, remember: { decision: "allow" }, persist: undefined });
  assert.deepEqual(always, { verdict: { kind: "allow" }, remember: { decision: "allow" }, persist: { decision: "allow" } });
  assert.equal(once.verdict.kind, "deny");
  assert.match(once.verdict.reason, /The user's reason: too slow/);
  assert.equal(once.remember, undefined);
  assert.equal(once.persist, undefined);
});

test("recording a denial moves the provider out of the allowed list", () => {
  // arrange
  const allowed = emptyProviderDecisions().record("openai", { decision: "allow" });

  // act
  const denied = allowed.record("openai", { decision: "deny", note: undefined });

  // assert
  assert.deepEqual([...denied.allowed], []);
  assert.deepEqual([...denied.denied], [["openai", undefined]]);
});

test("the file format round-trips and drops malformed entries", () => {
  // arrange
  const decisions = new ProviderDecisions(new Set(["openai"]), new Map([["greenpt", "too slow"], ["mistral", undefined]]));
  const damaged = {
    version: 1,
    allowed: ["openai", 3],
    denied: [{ provider: "greenpt", note: "too slow" }, { provider: "mistral" }, { provider: 4 }, { provider: "x", note: 5 }, "y"],
  };

  // act
  const roundTrip = parseProviderDecisions(decisions.toJson());
  const repaired = parseProviderDecisions(damaged);

  // assert
  assert.deepEqual(roundTrip.ok ? roundTrip.decisions.toJson() : undefined, decisions.toJson());
  assert.deepEqual(repaired.ok ? repaired.decisions.toJson() : undefined, decisions.toJson());
});

test("another file version is rejected", () => {
  // arrange
  const file = { version: 2, allowed: [], denied: [] };

  // act
  const parsed = parseProviderDecisions(file);

  // assert
  assert.deepEqual(parsed, { ok: false, error: "has version 2, expected 1" });
});

test("providerList joins one, two and three providers", () => {
  // arrange
  const lists = [["a"], ["a", "b"], ["a", "b", "c"]];

  // act
  const texts = lists.map(providerList);

  // assert
  assert.deepEqual(texts, ["a", "a and b", "a, b and c"]);
});
