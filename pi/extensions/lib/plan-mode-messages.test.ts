import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activateMissingPlanTools,
  createPlanModeDelivery,
  latestSnapshotContent,
  PlanModeState,
  renderSnapshot,
  SandboxStatus,
  type PlanModeSnapshot,
} from "./plan-mode-messages.ts";

const HEADER = "This is the current plan-mode state. It supersedes all earlier plan-mode state messages.";

test("the planning snapshot carries the workflow, plans directory and denials with their notes", () => {
  // arrange
  const state = snapshot({
    denials: [{ name: "web_search", note: "Use the docs in the repository" }, { name: "bash" }],
  });

  // act
  const content = renderSnapshot(state);

  // assert
  assert.ok(content.startsWith(`${HEADER}\n`));
  assert.match(content, /Plan mode is active\./);
  assert.match(content, /the plans directory \(\/agent\/plans\/repository\)/);
  assert.match(content, /call plan_path once/);
  assert.match(content, /An approved crit_review plan automatically opens the submission dialog/);
  assert.match(content, /do not retry it/);
  assert.match(content, /Only the user can leave plan mode\./);
  assert.match(content, / {2}- bash\n {2}- web_search \(do this instead: Use the docs in the repository\)/);
});

test("bash wording follows the sandbox status", () => {
  // arrange
  const sandboxed = snapshot({ sandbox: SandboxStatus.Active });
  const unsandboxed = snapshot({ sandbox: SandboxStatus.Inactive });

  // act
  const withSandbox = renderSnapshot(sandboxed);
  const withoutSandbox = renderSnapshot(unsandboxed);

  // assert
  assert.match(withSandbox, /bash runs in the sandbox/);
  assert.match(withSandbox, /unsandboxed: true still needs the user's confirmation/);
  assert.doesNotMatch(withSandbox, /bash needs the user's approval/);
  assert.match(withoutSandbox, /bash needs the user's approval for each call/);
});

test("the execution snapshot revokes planning instructions and ignores plan-only inputs", () => {
  // arrange
  const plain = snapshot({ mode: PlanModeState.Execution });
  const withDenials = snapshot({ mode: PlanModeState.Execution, denials: [{ name: "bash", note: "No" }], sandbox: SandboxStatus.Active });

  // act
  const content = renderSnapshot(plain);

  // assert
  assert.ok(content.startsWith(`${HEADER}\n`));
  assert.match(content, /Plan mode is off\. The planning restrictions and instructions from earlier plan-mode state messages no longer apply\./);
  assert.match(content, /plan_path and submit_plan reject every call until the user enables plan mode again/);
  assert.match(content, /ordinary sandbox and path permissions still apply/);
  assert.equal(renderSnapshot(withDenials), content);
});

test("denial order does not change the rendered content, but notes do", () => {
  // arrange
  const forward = snapshot({ denials: [{ name: "a" }, { name: "b", note: "x" }] });
  const backward = snapshot({ denials: [{ name: "b", note: "x" }, { name: "a" }] });
  const changedNote = snapshot({ denials: [{ name: "a" }, { name: "b", note: "y" }] });

  // act
  const forwardContent = renderSnapshot(forward);

  // assert
  assert.equal(renderSnapshot(backward), forwardContent);
  assert.notEqual(renderSnapshot(changedNote), forwardContent);
});

test("the latest snapshot is found by type, with array content normalized", () => {
  // arrange
  const messages = [
    stateMessage("old"),
    { role: "custom", customType: "plan-mode-state", content: [{ type: "text", text: "latest" }, { type: "image", data: "" }] },
    { role: "custom", customType: "other", content: "unrelated" },
    { role: "user", content: "plan-mode-state" },
  ];

  // act
  const latest = latestSnapshotContent(messages);
  const none = latestSnapshotContent([{ role: "user", content: "hello" }]);

  // assert
  assert.equal(latest, "latest");
  assert.equal(none, undefined);
});

test("an announcement is skipped when the session already shows the content", () => {
  // arrange
  const sent: string[] = [];
  const delivery = createPlanModeDelivery((content) => sent.push(content));

  // act
  delivery.announce("on", [stateMessage("on")]);

  // assert
  assert.deepEqual(sent, []);
});

test("queued transitions are all sent in order and identical queued content is suppressed", () => {
  // arrange
  const sent: string[] = [];
  const delivery = createPlanModeDelivery((content) => sent.push(content));
  const visible = [stateMessage("off")];

  // act
  delivery.announce("on", visible);
  delivery.announce("on", visible);
  delivery.announce("off", visible);
  delivery.announce("off", visible);

  // assert
  assert.deepEqual(sent, ["on", "off"]);
});

test("the initial message is returned only when the session lacks the current content", () => {
  // arrange
  const delivery = createPlanModeDelivery(() => assert.fail("initialMessage must not send"));

  // act
  const missing = delivery.initialMessage("on", []);
  const obsolete = delivery.initialMessage("on", [stateMessage("off")]);
  const current = delivery.initialMessage("on", [stateMessage("off"), stateMessage("on")]);

  // assert
  assert.equal(missing, "on");
  assert.equal(obsolete, "on");
  assert.equal(current, undefined);
});

test("a request that keeps the current snapshot is left untouched", () => {
  // arrange
  const sent: string[] = [];
  const delivery = createPlanModeDelivery((content) => sent.push(content));
  const messages = [stateMessage("on"), { role: "user", content: "hello" }];

  // act
  const result = delivery.requestMessages(messages, "on", messages);

  // assert
  assert.equal(result, undefined);
  assert.deepEqual(sent, []);
});

test("a request that lost the snapshot gets it appended and one durable copy is queued", () => {
  // arrange
  const sent: string[] = [];
  const delivery = createPlanModeDelivery((content) => sent.push(content));
  const compacted = [{ role: "compactionSummary", summary: "Plan mode is active." }, { role: "user", content: "next" }];
  const original = structuredClone(compacted);

  // act
  const first = delivery.requestMessages(compacted, "on", compacted);
  const second = delivery.requestMessages(compacted, "on", compacted);

  // assert
  assert.deepEqual(first?.slice(0, -1), original);
  assert.deepEqual(compacted, original);
  assert.equal(latestSnapshotContent(first ?? []), "on");
  assert.equal(latestSnapshotContent(second ?? []), "on");
  assert.deepEqual(sent, ["on"]);
});

test("an obsolete snapshot in the request is superseded rather than removed", () => {
  // arrange
  const delivery = createPlanModeDelivery(() => undefined);
  const messages = [stateMessage("on"), { role: "user", content: "next" }];

  // act
  const result = delivery.requestMessages(messages, "off", messages);

  // assert
  assert.deepEqual(result?.slice(0, 2), messages);
  assert.equal(latestSnapshotContent(result ?? []), "off");
});

test("a second compaction restores the same content again once the durable copy was seen", () => {
  // arrange
  const sent: string[] = [];
  const delivery = createPlanModeDelivery((content) => sent.push(content));
  delivery.requestMessages([], "on", []);
  delivery.requestMessages([stateMessage("on")], "on", [stateMessage("on")]);

  // act
  const result = delivery.requestMessages([], "on", []);

  // assert
  assert.equal(latestSnapshotContent(result ?? []), "on");
  assert.deepEqual(sent, ["on", "on"]);
});

test("no durable copy is queued when only the request lost a snapshot the session still shows", () => {
  // arrange
  const sent: string[] = [];
  const delivery = createPlanModeDelivery((content) => sent.push(content));

  // act
  const result = delivery.requestMessages([], "on", [stateMessage("on")]);

  // assert
  assert.equal(latestSnapshotContent(result ?? []), "on");
  assert.deepEqual(sent, []);
});

test("reset forgets queued content so a new branch is compared on its own", () => {
  // arrange
  const sent: string[] = [];
  const delivery = createPlanModeDelivery((content) => sent.push(content));
  delivery.announce("on", []);

  // act
  delivery.reset();
  delivery.announce("on", [stateMessage("off")]);

  // assert
  assert.deepEqual(sent, ["on", "on"]);
});

test("the migration appends only missing planning tools and keeps unrelated order", () => {
  // arrange
  const calls: string[][] = [];
  let active = ["write", "plan_path", "read"];
  const pi = {
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      calls.push(names);
      active = names;
    },
  };

  // act
  activateMissingPlanTools(pi);
  activateMissingPlanTools(pi);

  // assert
  assert.deepEqual(calls, [["write", "plan_path", "read", "submit_plan"]]);
});

function snapshot(overrides: Partial<PlanModeSnapshot> = {}): PlanModeSnapshot {
  return {
    mode: PlanModeState.Planning,
    plansDirectory: "/agent/plans/repository",
    sandbox: SandboxStatus.Inactive,
    denials: [],
    ...overrides,
  };
}

function stateMessage(content: string) {
  return { role: "custom", customType: "plan-mode-state", content, display: false, timestamp: 0 };
}
