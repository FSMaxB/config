import assert from "node:assert/strict";
import { test } from "node:test";
import { activeRestrictedMode, latestModeEntry } from "./mode-entry.ts";

test("the current branch selects its own mode and session decisions", () => {
  // arrange
  const root = stateEntry({ enabled: false, sessionGrants: [], sessionDenials: [] });
  const planning = stateEntry({ enabled: true, sessionGrants: ["bash"], sessionDenials: [{ name: "web_search", note: "Stay offline" }] });
  const execution = stateEntry({ enabled: false, sessionGrants: ["edit"], sessionDenials: ["fetch_content"] });
  const entries = [root, planning, execution];
  const onPlanningBranch = { getEntries: () => entries, getBranch: () => [root, planning] };
  const onExecutionBranch = { getEntries: () => entries, getBranch: () => [root, execution] };

  // act
  const planningState = latestModeEntry(onPlanningBranch, "plan-mode");
  const executionState = latestModeEntry(onExecutionBranch, "plan-mode");

  // assert
  assert.deepEqual(planningState, {
    enabled: true,
    sessionGrants: ["bash"],
    sessionDenials: [{ name: "web_search", note: "Stay offline" }],
  });
  assert.deepEqual(executionState, {
    enabled: false,
    sessionGrants: ["edit"],
    sessionDenials: [{ name: "fetch_content" }],
  });
});

test("a branch without state ignores state recorded on other branches", () => {
  // arrange
  const sibling = stateEntry({ enabled: true, sessionGrants: [], sessionDenials: [] });
  const manager = { getEntries: () => [sibling], getBranch: () => [{ type: "message" }] };

  // act
  const state = latestModeEntry(manager, "plan-mode");

  // assert
  assert.equal(state, undefined);
});

test("the branch is read through the session manager, keeping its method binding", () => {
  // arrange
  const entry = stateEntry({ enabled: true });
  const manager = {
    branch: [entry],
    getEntries: () => [],
    getBranch() {
      return this.branch;
    },
  };

  // act
  const state = latestModeEntry(manager, "plan-mode");

  // assert
  assert.equal(state?.enabled, true);
});

test("adapters without getBranch fall back to all entries", () => {
  // arrange
  const manager = { getEntries: () => [stateEntry({ enabled: false }), stateEntry({ enabled: true, sessionGrants: ["bash"] })] };

  // act
  const state = latestModeEntry(manager, "plan-mode");

  // assert
  assert.deepEqual(state, { enabled: true, sessionGrants: ["bash"], sessionDenials: [] });
});

test("the last enabled entry on the branch decides the active mode", () => {
  // arrange
  const planning = stateEntry({ enabled: true, sessionGrants: ["bash"] });
  const exploring = stateEntry({ enabled: true, sessionGrants: ["edit"] }, "explore-mode");
  const planningFirst = { getEntries: () => [], getBranch: () => [planning, exploring] };
  const exploringFirst = { getEntries: () => [], getBranch: () => [exploring, planning] };

  // act
  const exploringWins = activeRestrictedMode(planningFirst);
  const planningWins = activeRestrictedMode(exploringFirst);

  // assert
  assert.equal(exploringWins.mode, "exploring");
  assert.deepEqual(exploringWins.entry?.sessionGrants, ["edit"]);
  assert.equal(planningWins.mode, "planning");
  assert.deepEqual(planningWins.entry?.sessionGrants, ["bash"]);
});

test("a mode that was disabled later does not shadow the enabled one", () => {
  // arrange
  const exploring = stateEntry({ enabled: true }, "explore-mode");
  const planningOff = stateEntry({ enabled: false });
  const manager = { getEntries: () => [], getBranch: () => [exploring, planningOff] };

  // act
  const active = activeRestrictedMode(manager);

  // assert
  assert.equal(active.mode, "exploring");
});

test("without an enabled entry the branch is in execution mode, recorded or not", () => {
  // arrange
  const disabled = { getEntries: () => [], getBranch: () => [stateEntry({ enabled: false }), stateEntry({ enabled: false }, "explore-mode")] };
  const empty = { getEntries: () => [], getBranch: () => [{ type: "message" }] };

  // act
  const afterSwitchBack = activeRestrictedMode(disabled);
  const untouched = activeRestrictedMode(empty);

  // assert
  assert.deepEqual(afterSwitchBack, { mode: "execution", entry: undefined, recorded: true });
  assert.deepEqual(untouched, { mode: "execution", entry: undefined, recorded: false });
});

function stateEntry(data: Record<string, unknown>, customType = "plan-mode") {
  return { type: "custom", customType, data };
}
