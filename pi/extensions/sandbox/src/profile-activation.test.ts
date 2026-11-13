import assert from "node:assert/strict";
import test from "node:test";
import { AgentMode } from "../../lib/agent-mode.ts";
import { ALLOW_ONCE, ALLOW_SESSION } from "../../lib/permission-choices.ts";
import { Duration } from "../../lib/permission-prompt.ts";
import { activationOutcome, activationPrompt, ActivationScope, emptyProfileState, parseProfileState, profileSessionGrants, resolveActivationAnswer, serializeProfileState, settledResolution, type ActivationSituation } from "./profile-activation.ts";
import { emptyActivationDecisions, emptyProfileDefinition, type Profile } from "./profiles.ts";

const profile: Profile = { name: "bazel", ...emptyProfileDefinition() };

function situation(overrides: Partial<ActivationSituation> = {}): ActivationSituation {
  return { agentMode: AgentMode.Execution, hasUI: true, always: emptyActivationDecisions(), ...overrides };
}

test("a session denial refuses with the reason", () => {
  // arrange
  const state = emptyProfileState();
  state.denied.set("bazel", "no network");

  // act
  const outcome = activationOutcome(profile, state, situation());

  // assert
  assert.deepEqual(outcome, { kind: "refuse", reason: "The user denied sandbox profile bazel for this session. The user's reason: no network" });
});

test("a session denial without a note has no reason sentence", () => {
  // arrange
  const state = emptyProfileState();
  state.denied.set("bazel", undefined);

  // act
  const outcome = activationOutcome(profile, state, situation());

  // assert
  assert.deepEqual(outcome, { kind: "refuse", reason: "The user denied sandbox profile bazel for this session." });
});

test("an always denial refuses and an always allowance activates for the session", () => {
  // arrange
  const denying = emptyActivationDecisions();
  denying.denied.set("bazel", "slow");
  const allowing = emptyActivationDecisions();
  allowing.allowed.add("bazel");

  // act
  const denied = activationOutcome(profile, emptyProfileState(), situation({ always: denying }));
  const allowed = activationOutcome(profile, emptyProfileState(), situation({ always: allowing }));

  // assert
  assert.deepEqual(denied, { kind: "refuse", reason: "The user always denies sandbox profile bazel. The user's reason: slow" });
  assert.deepEqual(allowed, { kind: "activate", scope: ActivationScope.Session });
});

test("a session denial beats an always allowance", () => {
  // arrange
  const state = emptyProfileState();
  state.denied.set("bazel", undefined);
  const always = emptyActivationDecisions();
  always.allowed.add("bazel");

  // act
  const outcome = activationOutcome(profile, state, situation({ always }));

  // assert
  assert.equal(outcome.kind, "refuse");
});

test("without a UI the activation is refused", () => {
  // arrange, act
  const outcome = activationOutcome(profile, emptyProfileState(), situation({ hasUI: false }));

  // assert
  assert.equal(outcome.kind, "refuse");
  assert.match((outcome as { reason: string }).reason, /no interactive UI/);
});

test("the preselected answer depends on the agent mode", () => {
  // arrange
  const modes = [AgentMode.Execution, AgentMode.Planning, AgentMode.Exploring];

  // act
  const outcomes = modes.map((agentMode) => activationOutcome(profile, emptyProfileState(), situation({ agentMode })));

  // assert
  assert.deepEqual(outcomes, [
    { kind: "ask", preselected: ALLOW_SESSION },
    { kind: "ask", preselected: ALLOW_ONCE },
    { kind: "ask", preselected: ALLOW_ONCE },
  ]);
});

test("allow answers map to scope, session memory and persistence", () => {
  // arrange
  const answer = (duration: Duration) => resolveActivationAnswer(profile, { decision: "allow", duration, scope: "bazel" });

  // act
  const once = answer(Duration.Once);
  const session = answer(Duration.Session);
  const always = answer(Duration.Always);

  // assert
  assert.deepEqual(once, { kind: "activate", scope: ActivationScope.Once, remember: undefined, persist: undefined });
  assert.deepEqual(session, { kind: "activate", scope: ActivationScope.Session, remember: { decision: "allow" }, persist: undefined });
  assert.deepEqual(always, { kind: "activate", scope: ActivationScope.Session, remember: { decision: "allow" }, persist: { decision: "allow" } });
});

test("deny answers map to a refusal, session memory and persistence", () => {
  // arrange
  const answer = (duration: Duration) => resolveActivationAnswer(profile, { decision: "deny", duration, note: "later" });
  const denial = { decision: "deny", note: "later" };
  const reason = "The user denied sandbox profile bazel. The user's reason: later";

  // act
  const once = answer(Duration.Once);
  const session = answer(Duration.Session);
  const always = answer(Duration.Always);

  // assert
  assert.deepEqual(once, { kind: "refuse", reason, remember: undefined, persist: undefined });
  assert.deepEqual(session, { kind: "refuse", reason, remember: denial, persist: undefined });
  assert.deepEqual(always, { kind: "refuse", reason, remember: denial, persist: denial });
});

test("the prompt names the trigger and caps each list at five entries", () => {
  // arrange
  const big: Profile = {
    ...profile,
    filesystem: { read: ["/a", "/b", "/c", "/d", "/e", "/f", "/g"], write: ["/w"] },
    network: { allowedDomains: ["x.example"], allowLocalBinding: true, allowUnixSockets: [] },
    path: ["~/shims"],
  };

  // act
  const text = activationPrompt(big, { kind: "trigger", match: { kind: "command", command: "bazel" }, command: "bazel build //..." });

  // assert
  assert.match(text, /activate profile "bazel"\?/);
  assert.match(text, /Triggered by `bazel` in: bazel build \/\/\.\.\./);
  assert.match(text, /read: \/a, \/b, \/c, \/d, \/e, … \(\+2 more\)/);
  assert.match(text, /write: \/w/);
  assert.match(text, /hosts: x\.example/);
  assert.match(text, /local binding: yes/);
  assert.match(text, /PATH: ~\/shims/);
  assert.match(activationPrompt(profile, { kind: "tool" }), /Requested by the agent/);
});

test("a long triggering command keeps its tail", () => {
  // arrange
  const command = `bazel ${"x".repeat(400)} --evil`;

  // act
  const text = activationPrompt(profile, { kind: "trigger", match: { kind: "command", command: "bazel" }, command });

  // assert
  assert.match(text, /characters omitted/);
  assert.match(text, /--evil/);
});

test("state round-trips, ignores junk and never restores a pending once-activation", () => {
  // arrange
  const state = emptyProfileState();
  state.active.add("a");
  state.denied.set("b", "reason");
  state.denied.set("c", undefined);
  state.pendingOnce.add("d");

  // act
  const restored = parseProfileState(serializeProfileState(state));
  const junk = parseProfileState({ active: ["x", 1], denied: { y: 5, z: "why" } });
  const nothing = parseProfileState("junk");

  // assert
  assert.deepEqual([...restored.active], ["a"]);
  assert.deepEqual([...restored.denied], [["b", "reason"], ["c", undefined]]);
  assert.equal(restored.pendingOnce.size, 0);
  assert.deepEqual([...junk.active], ["x"]);
  assert.deepEqual([...junk.denied], [["y", undefined], ["z", "why"]]);
  assert.deepEqual([...nothing.active], []);
});

test("session grants list active profiles before denied ones", () => {
  // arrange
  const state = emptyProfileState();
  state.active.add("b");
  state.active.add("a");
  state.denied.set("c", undefined);

  // act
  const grants = profileSessionGrants(state);

  // assert
  assert.deepEqual(grants, [
    { kind: "profile", decision: "allow", name: "a" },
    { kind: "profile", decision: "allow", name: "b" },
    { kind: "profile", decision: "deny", name: "c" },
  ]);
});

test("a settled outcome resolves like an answer without persistence", () => {
  // arrange
  const refusal = { kind: "refuse", reason: "no" } as const;
  const activation = { kind: "activate", scope: ActivationScope.Session } as const;

  // act
  const refused = settledResolution(refusal);
  const activated = settledResolution(activation);

  // assert
  assert.deepEqual(refused, { kind: "refuse", reason: "no", remember: undefined, persist: undefined });
  assert.deepEqual(activated, { kind: "activate", scope: ActivationScope.Session, remember: { decision: "allow" }, persist: undefined });
});
