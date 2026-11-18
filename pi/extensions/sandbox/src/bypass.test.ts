import assert from "node:assert/strict";
import test from "node:test";
import { AgentMode } from "../../lib/agent-mode.ts";
import { ALLOW_ONCE, DENY_ONCE } from "../../lib/permission-choices.ts";
import { Duration } from "../../lib/permission-prompt.ts";
import { BYPASS_DURATIONS, bypassOutcome, bypassPrompt, bypassSessionGrants, resolveAnswer } from "./bypass.ts";
import type { BypassSituation } from "./bypass.ts";

const interactive: BypassSituation = { agentMode: AgentMode.Execution, subagent: false, hasUI: true, sessionDecision: undefined };

test("outside the restricted modes the prompt preselects allow", () => {
  // act
  const outcome = bypassOutcome(interactive);

  // assert
  assert.deepEqual(outcome, { kind: "ask", preselected: ALLOW_ONCE });
});

test("in plan and explore mode the prompt preselects deny", () => {
  // act
  const planning = bypassOutcome({ ...interactive, agentMode: AgentMode.Planning });
  const exploring = bypassOutcome({ ...interactive, agentMode: AgentMode.Exploring });

  // assert
  assert.equal(planning.kind === "ask" && planning.preselected, DENY_ONCE);
  assert.equal(exploring.kind === "ask" && exploring.preselected, DENY_ONCE);
});

test("the prompt offers no always durations", () => {
  // assert
  assert.deepEqual(BYPASS_DURATIONS, [Duration.Once, Duration.Session]);
});

test("subagents are refused even with a UI", () => {
  // act
  const outcome = bypassOutcome({ ...interactive, subagent: true });

  // assert
  assert.equal(outcome.kind, "refuse");
  assert.match(outcome.reason, /Subagents cannot/);
});

test("without a UI the bypass is refused instead of assumed", () => {
  // act
  const outcome = bypassOutcome({ ...interactive, hasUI: false });

  // assert
  assert.equal(outcome.kind, "refuse");
  assert.match(outcome.reason, /no interactive UI/);
});

test("a session decision skips the prompt", () => {
  // act
  const allowed = bypassOutcome({ ...interactive, sessionDecision: { decision: "allow" } });
  const denied = bypassOutcome({ ...interactive, sessionDecision: { decision: "deny", note: undefined } });

  // assert
  assert.deepEqual(allowed, { kind: "run" });
  assert.equal(denied.kind, "refuse");
});

test("a session denial refusal repeats the user's reason", () => {
  // act
  const denied = bypassOutcome({ ...interactive, sessionDecision: { decision: "deny", note: "needs review" } });

  // assert
  assert.match(denied.kind === "refuse" ? denied.reason : "", /The user's reason: needs review/);
});

test("answers map to authorizations and what to remember", () => {
  // act
  const once = resolveAnswer({ decision: "allow", duration: Duration.Once, scope: "echo hi" });
  const session = resolveAnswer({ decision: "allow", duration: Duration.Session, scope: "echo hi" });
  const denyOnce = resolveAnswer({ decision: "deny", duration: Duration.Once, note: undefined });
  const denySession = resolveAnswer({ decision: "deny", duration: Duration.Session, note: undefined });

  // assert
  assert.deepEqual(once, { authorization: { kind: "run" }, remember: undefined });
  assert.deepEqual(session, { authorization: { kind: "run" }, remember: { decision: "allow" } });
  assert.equal(denyOnce.authorization.kind, "refuse");
  assert.equal(denyOnce.remember, undefined);
  assert.equal(denySession.authorization.kind, "refuse");
  assert.deepEqual(denySession.remember, { decision: "deny", note: undefined });
});

test("a denial with a reason repeats it and a session denial remembers it", () => {
  // act
  const once = resolveAnswer({ decision: "deny", duration: Duration.Once, note: "use the sandbox" });
  const session = resolveAnswer({ decision: "deny", duration: Duration.Session, note: "use the sandbox" });

  // assert
  assert.match(once.authorization.kind === "refuse" ? once.authorization.reason : "", /The user's reason: use the sandbox/);
  assert.equal(once.remember, undefined);
  assert.deepEqual(session.remember, { decision: "deny", note: "use the sandbox" });
});

test("the prompt shortens long commands", () => {
  // arrange
  const command = "x".repeat(300);

  // act
  const prompt = bypassPrompt(command);

  // assert
  assert.ok(prompt.startsWith("Sandbox: run this command outside the sandbox?"));
  assert.match(prompt, /\[60 characters omitted\]/);
});

test("the prompt shows the end of a long command", () => {
  // arrange
  const command = `${"x".repeat(300)}-tail-marker-xyz`;

  // act
  const prompt = bypassPrompt(command);

  // assert
  assert.match(prompt, /tail-marker-xyz/);
});

test("an unsandboxed bash session decision is listed as a grant", () => {
  // act
  const none = bypassSessionGrants(undefined);
  const denied = bypassSessionGrants({ decision: "deny", note: "no" });

  // assert
  assert.deepEqual(none, []);
  assert.deepEqual(denied, [{ kind: "unsandboxed", decision: "deny" }]);
});
