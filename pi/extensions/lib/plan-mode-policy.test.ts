import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlanModeEntry } from "./plan-mode-entry.ts";
import { PlanModeState } from "./plan-mode-messages.ts";
import {
  APPROVE,
  APPROVE_CURRENT,
  blockedReason,
  effectiveDenials,
  IMPLEMENT_DIFFERENT,
  Interaction,
  REFINE,
  STAY,
  startupPlanMode,
  StartupRequest,
  StateRecording,
  SubmissionAction,
  submissionAction,
  submissionOptions,
  toolGate,
} from "./plan-mode-policy.ts";

test("the --plan flag enables plan mode and records it when the branch says otherwise", () => {
  // arrange
  const cases = [
    { restored: undefined, expected: { enabled: true, recording: StateRecording.Record } },
    { restored: entry(false), expected: { enabled: true, recording: StateRecording.Record } },
    { restored: entry(true), expected: { enabled: true, recording: StateRecording.Keep } },
  ];

  // act
  const results = cases.map(({ restored }) => startupPlanMode(restored, StartupRequest.Plan));

  // assert
  assert.deepEqual(results, cases.map(({ expected }) => expected));
});

test("without a startup request the branch keeps its recorded mode, defaulting to off", () => {
  // arrange
  const cases = [
    { restored: undefined, expected: { enabled: false, recording: StateRecording.Record } },
    { restored: entry(false), expected: { enabled: false, recording: StateRecording.Keep } },
    { restored: entry(true), expected: { enabled: true, recording: StateRecording.Keep } },
  ];

  // act
  const results = cases.map(({ restored }) => startupPlanMode(restored, StartupRequest.None));

  // assert
  assert.deepEqual(results, cases.map(({ expected }) => expected));
});

test("a fresh handoff session starts outside plan mode even though the flag is set", () => {
  // arrange
  const restored = undefined;

  // act
  const result = startupPlanMode(restored, StartupRequest.Handoff);

  // assert
  assert.deepEqual(result, { enabled: false, recording: StateRecording.Record });
});

test("outside plan mode every tool runs, denied ones included", () => {
  // arrange
  const denials = stores({ always: [["bash", undefined]] });

  // act
  const results = (["allow", "approval", "deny"] as const).map((permission) =>
    toolGate("bash", { mode: PlanModeState.Execution, denials, permission, interaction: Interaction.Unavailable }),
  );

  // assert
  assert.deepEqual(results, [{ kind: "run" }, { kind: "run" }, { kind: "run" }]);
});

test("in plan mode an explicit denial blocks before any grant or prompt", () => {
  // arrange
  const denials = stores({ session: [["web_search", "Use the docs"]] });

  // act
  const result = toolGate("web_search", {
    mode: PlanModeState.Planning,
    denials,
    permission: "allow",
    interaction: Interaction.Available,
  });

  // assert
  assert.equal(result.kind, "block");
  assert.match(result.kind === "block" ? result.reason : "", /you denied it for this session.*Do this instead: Use the docs/);
});

test("in plan mode allowed tools run and approval-required tools ask, or fail closed without a UI", () => {
  // arrange
  const denials = stores({});
  const state = (permission: "allow" | "approval", interaction: Interaction) =>
    ({ mode: PlanModeState.Planning, denials, permission, interaction }) as const;

  // act
  const allowed = toolGate("read", state("allow", Interaction.Unavailable));
  const ask = toolGate("fixture", state("approval", Interaction.Available));
  const noUI = toolGate("fixture", state("approval", Interaction.Unavailable));

  // assert
  assert.deepEqual(allowed, { kind: "run" });
  assert.deepEqual(ask, { kind: "ask" });
  assert.equal(noUI.kind, "block");
  assert.match(noUI.kind === "block" ? noUI.reason : "", /no interactive UI/);
});

test("an always denial takes precedence over a session denial in the gate and the snapshot", () => {
  // arrange
  const denials = stores({ session: [["bash", "session note"], ["edit", undefined]], always: [["bash", "always note"]] });

  // act
  const reason = blockedReason("bash", denials);
  const listed = effectiveDenials(denials);

  // assert
  assert.match(reason ?? "", /you denied it for all sessions.*always note/);
  assert.deepEqual(
    [...listed].sort((left, right) => left.name.localeCompare(right.name)),
    [{ name: "bash", note: "always note" }, { name: "edit" }],
  );
});

test("submission options offer the suggested model first and approve with the current one", () => {
  // arrange
  const suggested = "capture/other";

  // act
  const withSuggestion = submissionOptions(suggested);
  const withoutSuggestion = submissionOptions(undefined);

  // assert
  assert.deepEqual(withSuggestion, [
    "Approve — implement with capture/other (suggested)",
    APPROVE_CURRENT,
    IMPLEMENT_DIFFERENT,
    REFINE,
    STAY,
  ]);
  assert.deepEqual(withoutSuggestion, [APPROVE, IMPLEMENT_DIFFERENT, REFINE, STAY]);
});

test("each submission choice maps to its action", () => {
  // arrange
  const suggested = "capture/other";
  const [approveSuggested] = submissionOptions(suggested);

  // act
  const actions = [
    submissionAction(approveSuggested, suggested),
    submissionAction(APPROVE_CURRENT, suggested),
    submissionAction(APPROVE, undefined),
    submissionAction(IMPLEMENT_DIFFERENT, undefined),
    submissionAction(REFINE, undefined),
  ];

  // assert
  assert.deepEqual(actions, [
    SubmissionAction.ApproveSuggested,
    SubmissionAction.Approve,
    SubmissionAction.Approve,
    SubmissionAction.ImplementDifferent,
    SubmissionAction.Refine,
  ]);
});

test("staying, dismissing the dialog and unoffered choices keep plan mode on", () => {
  // arrange
  const choices = [STAY, undefined, APPROVE_CURRENT, "Approve — implement with capture/other (suggested)"];

  // act
  const actions = choices.map((choice) => submissionAction(choice, undefined));

  // assert
  assert.deepEqual(actions, Array(choices.length).fill(SubmissionAction.Stay));
});

function entry(enabled: boolean): PlanModeEntry {
  return { enabled, sessionGrants: [], sessionDenials: [] };
}

function stores({
  session = [],
  always = [],
}: {
  session?: [string, string | undefined][];
  always?: [string, string | undefined][];
}) {
  return { sessionDenials: new Map(session), alwaysDenials: new Map(always) };
}
