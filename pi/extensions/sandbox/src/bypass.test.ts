import assert from "node:assert/strict";
import test from "node:test";
import { AgentMode } from "../../lib/agent-mode.ts";
import { ALLOW_ONCE, ALLOW_SESSION, DENY_ONCE, DENY_SESSION } from "../../lib/permission-choices.ts";
import { bypassOutcome, bypassPrompt, resolveChoice, type BypassSituation } from "./bypass.ts";

const interactive: BypassSituation = { agentMode: AgentMode.Execution, subagent: false, hasUI: true, sessionDecision: undefined };

test("outside the restricted modes the prompt preselects allow", () => {
  // act
  const outcome = bypassOutcome(interactive);

  // assert
  assert.deepEqual(outcome, { kind: "ask", choices: [ALLOW_ONCE, ALLOW_SESSION, DENY_ONCE, DENY_SESSION], defaultChoice: ALLOW_ONCE });
});

test("in plan and explore mode the prompt preselects deny", () => {
  // act
  const planning = bypassOutcome({ ...interactive, agentMode: AgentMode.Planning });
  const exploring = bypassOutcome({ ...interactive, agentMode: AgentMode.Exploring });

  // assert
  assert.equal(planning.kind === "ask" && planning.defaultChoice, DENY_ONCE);
  assert.equal(exploring.kind === "ask" && exploring.defaultChoice, DENY_ONCE);
});

test("subagents are refused even with a UI", () => {
  // act
  const outcome = bypassOutcome({ ...interactive, subagent: true });

  // assert
  assert.equal(outcome.kind, "refuse");
  assert.match(outcome.kind === "refuse" ? outcome.reason : "", /Subagents cannot/);
});

test("without a UI the bypass is refused instead of assumed", () => {
  // act
  const outcome = bypassOutcome({ ...interactive, hasUI: false });

  // assert
  assert.equal(outcome.kind, "refuse");
  assert.match(outcome.kind === "refuse" ? outcome.reason : "", /no interactive UI/);
});

test("a session decision skips the prompt", () => {
  // act
  const allowed = bypassOutcome({ ...interactive, sessionDecision: "allow" });
  const denied = bypassOutcome({ ...interactive, sessionDecision: "deny" });

  // assert
  assert.deepEqual(allowed, { kind: "run" });
  assert.equal(denied.kind, "refuse");
});

test("choices map to authorizations and what to remember", () => {
  // act
  const once = resolveChoice(ALLOW_ONCE);
  const session = resolveChoice(ALLOW_SESSION);
  const denyOnce = resolveChoice(DENY_ONCE);
  const denySession = resolveChoice(DENY_SESSION);
  const dismissed = resolveChoice(undefined);

  // assert
  assert.deepEqual(once, { authorization: { kind: "run" }, remember: undefined });
  assert.deepEqual(session, { authorization: { kind: "run" }, remember: "allow" });
  assert.equal(denyOnce.authorization.kind, "refuse");
  assert.equal(denyOnce.remember, undefined);
  assert.equal(denySession.authorization.kind, "refuse");
  assert.equal(denySession.remember, "deny");
  assert.equal(dismissed.authorization.kind, "refuse");
  assert.equal(dismissed.remember, undefined);
});

test("the prompt shortens long commands", () => {
  // arrange
  const command = "x".repeat(300);

  // act
  const prompt = bypassPrompt(command);

  // assert
  assert.ok(prompt.startsWith("Sandbox: run this command outside the sandbox?"));
  assert.ok(prompt.endsWith("..."));
  assert.ok(prompt.length < command.length);
});
