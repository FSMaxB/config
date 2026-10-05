import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentMode, RESTRICTED_MODES } from "./agent-mode.ts";
import {
  blockedReason,
  deniedReason,
  effectiveDenials,
  Interaction,
  startupMode,
  StateRecording,
  Timing,
  toolGate,
  transitionNotice,
} from "./mode-policy.ts";

test("a requested mode starts and is recorded when the branch says otherwise", () => {
  // arrange
  const cases = [
    { restored: { mode: AgentMode.Execution, recorded: false }, expected: { mode: AgentMode.Planning, recording: StateRecording.Record } },
    { restored: { mode: AgentMode.Execution, recorded: true }, expected: { mode: AgentMode.Planning, recording: StateRecording.Record } },
    { restored: { mode: AgentMode.Exploring, recorded: true }, expected: { mode: AgentMode.Planning, recording: StateRecording.Record } },
    { restored: { mode: AgentMode.Planning, recorded: true }, expected: { mode: AgentMode.Planning, recording: StateRecording.Keep } },
  ];

  // act
  const results = cases.map(({ restored }) => startupMode(restored, [AgentMode.Planning]));

  // assert
  assert.deepEqual(results, cases.map(({ expected }) => expected));
});

test("without a startup request the branch keeps its recorded mode, defaulting to execution", () => {
  // arrange
  const cases = [
    { restored: { mode: AgentMode.Execution, recorded: false }, expected: { mode: AgentMode.Execution, recording: StateRecording.Record } },
    { restored: { mode: AgentMode.Execution, recorded: true }, expected: { mode: AgentMode.Execution, recording: StateRecording.Keep } },
    { restored: { mode: AgentMode.Planning, recorded: true }, expected: { mode: AgentMode.Planning, recording: StateRecording.Keep } },
    { restored: { mode: AgentMode.Exploring, recorded: true }, expected: { mode: AgentMode.Exploring, recording: StateRecording.Keep } },
  ];

  // act
  const results = cases.map(({ restored }) => startupMode(restored, []));

  // assert
  assert.deepEqual(results, cases.map(({ expected }) => expected));
});

test("the explore flag overrides a recorded plan mode, and plan wins when both flags are set", () => {
  // arrange
  const restored = { mode: AgentMode.Planning, recorded: true };

  // act
  const explore = startupMode(restored, [AgentMode.Exploring]);
  const both = startupMode({ mode: AgentMode.Execution, recorded: true }, [AgentMode.Planning, AgentMode.Exploring]);

  // assert
  assert.deepEqual(explore, { mode: AgentMode.Exploring, recording: StateRecording.Record });
  assert.deepEqual(both, { mode: AgentMode.Planning, recording: StateRecording.Record });
});

test("outside the restricted modes every tool runs, denied ones included", () => {
  // arrange
  const denials = stores({ always: [["bash", undefined]] });

  // act
  const results = (["allow", "approval", "deny"] as const).map((permission) =>
    toolGate("bash", { mode: AgentMode.Execution, denials, permission, interaction: Interaction.Unavailable }),
  );

  // assert
  assert.deepEqual(results, [{ kind: "run" }, { kind: "run" }, { kind: "run" }]);
});

test("in a restricted mode an explicit denial blocks before any grant or prompt", () => {
  for (const mode of RESTRICTED_MODES) {
    // arrange
    const denials = stores({ session: [["web_search", "Use the docs"]] });

    // act
    const result = toolGate("web_search", { mode, denials, permission: "allow", interaction: Interaction.Available });

    // assert
    assert.equal(result.kind, "block");
    assert.match(result.kind === "block" ? result.reason : "", /you denied it for this session.*Do this instead: Use the docs/);
  }
});

test("in a restricted mode allowed tools run and approval-required tools ask, or fail closed without a UI", () => {
  for (const mode of RESTRICTED_MODES) {
    // arrange
    const denials = stores({});
    const state = (permission: "allow" | "approval", interaction: Interaction) =>
      ({ mode, denials, permission, interaction }) as const;

    // act
    const allowed = toolGate("read", state("allow", Interaction.Unavailable));
    const ask = toolGate("fixture", state("approval", Interaction.Available));
    const noUI = toolGate("fixture", state("approval", Interaction.Unavailable));

    // assert
    assert.deepEqual(allowed, { kind: "run" });
    assert.deepEqual(ask, { kind: "ask" });
    assert.equal(noUI.kind, "block");
    assert.match(noUI.kind === "block" ? noUI.reason : "", /no interactive UI/);
  }
});

test("an always denial takes precedence over a session denial in the gate and the snapshot", () => {
  // arrange
  const denials = stores({ session: [["bash", "session note"], ["edit", undefined]], always: [["bash", "always note"]] });

  // act
  const reason = blockedReason(AgentMode.Planning, "bash", denials);
  const listed = effectiveDenials(denials);

  // assert
  assert.match(reason ?? "", /you denied it for all sessions.*always note/);
  assert.deepEqual(
    [...listed].sort((left, right) => left.name.localeCompare(right.name)),
    [{ name: "bash", note: "always note" }, { name: "edit" }],
  );
});

test("the denial text names the mode, and only plan mode points at submit_plan", () => {
  // act
  const planning = deniedReason(AgentMode.Planning, "bash", "you denied it");
  const exploring = deniedReason(AgentMode.Exploring, "bash", "you denied it");
  const withNote = deniedReason(AgentMode.Exploring, "bash", "you denied it", "Use grep");

  // assert
  assert.match(planning, /^Plan mode is active and you denied it, so bash did not run\./);
  assert.match(planning, /submit_plan/);
  assert.match(exploring, /^Explore mode is active/);
  assert.doesNotMatch(exploring, /submit_plan/);
  assert.match(withNote, /Do this instead: Use grep$/);
});

test("transition notices say what changes and when", () => {
  // act
  const notices = [
    transitionNotice(AgentMode.Execution, AgentMode.Exploring, Timing.Immediate),
    transitionNotice(AgentMode.Planning, AgentMode.Execution, Timing.Immediate),
    transitionNotice(AgentMode.Planning, AgentMode.Exploring, Timing.Immediate),
    transitionNotice(AgentMode.Execution, AgentMode.Planning, Timing.Deferred),
    transitionNotice(AgentMode.Exploring, AgentMode.Execution, Timing.Deferred),
    transitionNotice(AgentMode.Exploring, AgentMode.Planning, Timing.Deferred),
  ];

  // assert
  assert.deepEqual(notices, [
    "Explore mode enabled.",
    "Plan mode disabled.",
    "Plan mode disabled, explore mode enabled.",
    "Plan mode will be enabled at the next tool call.",
    "Explore mode will be disabled at the next tool call.",
    "Switching from explore mode to plan mode at the next tool call.",
  ]);
});

function stores({
  session = [],
  always = [],
}: {
  session?: [string, string | undefined][];
  always?: [string, string | undefined][];
}) {
  return { sessionDenials: new Map(session), alwaysDenials: new Map(always) };
}
