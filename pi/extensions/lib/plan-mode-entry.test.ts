import assert from "node:assert/strict";
import { test } from "node:test";
import { latestPlanModeEntry } from "./plan-mode-entry.ts";

test("the current branch selects its own mode and session decisions", () => {
  // arrange
  const root = stateEntry({ enabled: false, sessionGrants: [], sessionDenials: [] });
  const planning = stateEntry({ enabled: true, sessionGrants: ["bash"], sessionDenials: [{ name: "web_search", note: "Stay offline" }] });
  const execution = stateEntry({ enabled: false, sessionGrants: ["edit"], sessionDenials: ["fetch_content"] });
  const entries = [root, planning, execution];
  const onPlanningBranch = { getEntries: () => entries, getBranch: () => [root, planning] };
  const onExecutionBranch = { getEntries: () => entries, getBranch: () => [root, execution] };

  // act
  const planningState = latestPlanModeEntry(onPlanningBranch);
  const executionState = latestPlanModeEntry(onExecutionBranch);

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
  const state = latestPlanModeEntry(manager);

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
  const state = latestPlanModeEntry(manager);

  // assert
  assert.equal(state?.enabled, true);
});

test("adapters without getBranch fall back to all entries", () => {
  // arrange
  const manager = { getEntries: () => [stateEntry({ enabled: false }), stateEntry({ enabled: true, sessionGrants: ["bash"] })] };

  // act
  const state = latestPlanModeEntry(manager);

  // assert
  assert.deepEqual(state, { enabled: true, sessionGrants: ["bash"], sessionDenials: [] });
});

function stateEntry(data: Record<string, unknown>) {
  return { type: "custom", customType: "plan-mode", data };
}
