import assert from "node:assert/strict";
import test from "node:test";
import { AgentMode } from "../../lib/agent-mode.ts";
import { ALLOW_ONCE, ALLOW_SESSION } from "../../lib/permission-choices.ts";
import { Duration } from "../../lib/permission-prompt.ts";
import { activationOutcome, activationPrompt, emptyProfileState, parseProfileState, profileSessionGrants, resolveActivationAnswer, serializeProfileState, settledResolution } from "./profile-activation.ts";
import type { ActivationSituation } from "./profile-activation.ts";
import { NetworkAccess, emptyActivationDecisions, emptyProfileDefinition } from "./profiles.ts";
import type { Profile } from "./profiles.ts";

const profile: Profile = { name: "bazel", ...emptyProfileDefinition() };

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
  assert.deepEqual(allowed, { kind: "activate" });
});

test("a session allowance activates without a prompt, and a session denial still beats it", () => {
  // arrange
  const allowing = emptyProfileState();
  allowing.allowed.add("bazel");
  const denying = emptyProfileState();
  denying.allowed.add("bazel");
  denying.denied.set("bazel", undefined);

  // act
  const allowed = activationOutcome(profile, allowing, situation());
  const denied = activationOutcome(profile, denying, situation());

  // assert
  assert.deepEqual(allowed, { kind: "activate" });
  assert.equal(denied.kind, "refuse");
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

function situation(overrides: Partial<ActivationSituation> = {}): ActivationSituation {
  return { agentMode: AgentMode.Execution, hasUI: true, always: emptyActivationDecisions(), ...overrides };
}

test("allow answers map to session memory and persistence", () => {
  // arrange
  const answer = (duration: Duration) => resolveActivationAnswer(profile, { decision: "allow", duration, scope: "bazel" });

  // act
  const once = answer(Duration.Once);
  const session = answer(Duration.Session);
  const always = answer(Duration.Always);

  // assert
  assert.deepEqual(once, { kind: "activate", remember: undefined, persist: undefined });
  assert.deepEqual(session, { kind: "activate", remember: { decision: "allow" }, persist: undefined });
  assert.deepEqual(always, { kind: "activate", remember: { decision: "allow" }, persist: { decision: "allow" } });
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
    filesystem: { read: ["/a", "/b", "/c", "/d", "/e", "/f", "/g"], write: ["/w"], secretRead: ["~/.config/gh"] },
    network: { access: NetworkAccess.Listed, allowedDomains: ["x.example"], allowLocalBinding: true, allowUnixSockets: [], enableWeakerNetworkIsolation: true },
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
  assert.match(text, /read secrets: ~\/\.config\/gh/);
  assert.match(text, /local binding: yes/);
  assert.match(text, /trustd \(Go TLS verification, weaker network isolation\): yes/);
  assert.match(text, /PATH: ~\/shims/);
  assert.match(text, /Applies to this bash call only/);
});

test("the prompt names a request and the network access level", () => {
  // arrange
  const open: Profile = { ...profile, network: { ...profile.network, access: NetworkAccess.All } };

  // act
  const requested = activationPrompt(open, { kind: "request", command: "./build.sh" });
  const quiet = activationPrompt(profile, { kind: "request", command: "./build.sh" });

  // assert
  assert.match(requested, /Requested by the agent for: \.\/build\.sh/);
  assert.match(requested, /network: every host/);
  assert.match(requested, /shared with bash calls running at the same time/);
  assert.doesNotMatch(quiet, /shared with bash calls running at the same time/);
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

test("state round-trips, ignores junk and reads the legacy active key as an approval", () => {
  // arrange
  const state = emptyProfileState();
  state.allowed.add("a");
  state.denied.set("b", "reason");
  state.denied.set("c", undefined);

  // act
  const restored = parseProfileState(serializeProfileState(state));
  const junk = parseProfileState({ active: ["x", 1], denied: { y: 5, z: "why" } });
  const legacy = parseProfileState({ active: ["legacy"] });
  const nothing = parseProfileState("junk");

  // assert
  assert.deepEqual([...restored.allowed], ["a"]);
  assert.deepEqual([...restored.denied], [["b", "reason"], ["c", undefined]]);
  assert.deepEqual([...junk.allowed], ["x"]);
  assert.deepEqual([...junk.denied], [["y", undefined], ["z", "why"]]);
  assert.deepEqual([...legacy.allowed], ["legacy"]);
  assert.deepEqual([...nothing.allowed], []);
});

test("session grants list allowed profiles before denied ones", () => {
  // arrange
  const state = emptyProfileState();
  state.allowed.add("b");
  state.allowed.add("a");
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

test("a settled outcome resolves like an answer without memory or persistence", () => {
  // arrange
  const refusal = { kind: "refuse", reason: "no" } as const;
  const activation = { kind: "activate" } as const;

  // act
  const refused = settledResolution(refusal);
  const activated = settledResolution(activation);

  // assert
  assert.deepEqual(refused, { kind: "refuse", reason: "no", remember: undefined, persist: undefined });
  assert.deepEqual(activated, { kind: "activate", remember: undefined, persist: undefined });
});
