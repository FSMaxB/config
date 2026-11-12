import assert from "node:assert/strict";
import test from "node:test";
import { SandboxViolationStore } from "@anthropic-ai/sandbox-runtime";
import { startViolationCollector } from "./violation-collector.ts";

test("every violation of a tracked command survives the store's 100-entry ring", () => {
  // arrange
  const store = new SandboxViolationStore();
  const collector = startViolationCollector("linux", store);
  collector.track("command-1");

  // act
  for (let index = 0; index < 150; index += 1) addViolation(store, "command-1", `file-write-create /tmp/${index}`);

  // assert
  assert.equal(collector.violationsFor("command-1").length, 150);
  assert.equal(store.getViolationsForCommand("command-1").length, 100);
  collector.stop();
});

test("violations of an untracked command are not kept", () => {
  // arrange
  const store = new SandboxViolationStore();
  const collector = startViolationCollector("linux", store);
  collector.track("tracked");

  // act
  addViolation(store, "other", "file-write-create /tmp/other");

  // assert
  assert.deepEqual(collector.violationsFor("tracked"), []);
  assert.deepEqual(collector.violationsFor("other"), []);
  collector.stop();
});

test("releasing a command drops its violations and later ones", () => {
  // arrange
  const store = new SandboxViolationStore();
  const collector = startViolationCollector("linux", store);
  collector.track("command-1");
  addViolation(store, "command-1", "file-write-create /tmp/a");

  // act
  collector.release("command-1");
  addViolation(store, "command-1", "file-write-create /tmp/b");

  // assert
  assert.deepEqual(collector.violationsFor("command-1"), []);
  collector.stop();
});

test("clearing the store adds no violations", () => {
  // arrange
  const store = new SandboxViolationStore();
  const collector = startViolationCollector("linux", store);
  collector.track("command-1");
  addViolation(store, "command-1", "file-write-create /tmp/a");

  // act
  store.clear();

  // assert
  assert.deepEqual(collector.violationsFor("command-1"), [{ line: "file-write-create /tmp/a" }]);
  collector.stop();
});

test("a violation added after the store was cleared is still collected", () => {
  // arrange
  const store = new SandboxViolationStore();
  const collector = startViolationCollector("linux", store);
  collector.track("command-1");
  addViolation(store, "command-1", "file-write-create /tmp/a");
  store.clear();

  // act
  addViolation(store, "command-1", "file-write-create /tmp/b");

  // assert
  assert.deepEqual(collector.violationsFor("command-1").map(({ line }) => line), ["file-write-create /tmp/a", "file-write-create /tmp/b"]);
  collector.stop();
});

function addViolation(store: SandboxViolationStore, commandId: string, line: string): void {
  store.addViolation({ line, command: commandId, encodedCommand: Buffer.from(commandId).toString("base64"), timestamp: new Date() });
}
