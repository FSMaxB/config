import assert from "node:assert/strict";
import test from "node:test";
import { SandboxViolationStore } from "@anthropic-ai/sandbox-runtime";
import { isProxyViolation, isSystemNoise, startViolationCollector } from "./violation-collector.ts";

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

test("a violation tagged with an adopted id also reaches the adopting command", () => {
  // arrange
  const store = new SandboxViolationStore();
  const collector = startViolationCollector("linux", store);
  collector.track("server-starter");
  collector.release("server-starter");
  collector.track("later", ["server-starter"]);

  // act
  addViolation(store, "server-starter", "file-write-create /tmp/from-server");

  // assert
  assert.deepEqual(collector.violationsFor("later"), [{ line: "file-write-create /tmp/from-server" }]);
  collector.stop();
});

test("a violation is delivered once to a command that owns and adopts the same id", () => {
  // arrange
  const store = new SandboxViolationStore();
  const collector = startViolationCollector("linux", store);
  collector.track("self", ["other"]);

  // act
  addViolation(store, "other", "file-write-create /tmp/a");
  addViolation(store, "self", "file-write-create /tmp/b");

  // assert
  assert.deepEqual(collector.violationsFor("self").map(({ line }) => line), ["file-write-create /tmp/a", "file-write-create /tmp/b"]);
  collector.stop();
});

test("releasing an adopting command clears its adoptions", () => {
  // arrange
  const store = new SandboxViolationStore();
  const collector = startViolationCollector("linux", store);
  collector.track("later", ["server-starter"]);
  collector.release("later");
  collector.track("later", []);

  // act
  addViolation(store, "server-starter", "file-write-create /tmp/x");

  // assert
  assert.deepEqual(collector.violationsFor("later"), []);
  collector.stop();
});

function addViolation(store: SandboxViolationStore, commandId: string, line: string): void {
  store.addViolation({ line, command: commandId, encodedCommand: Buffer.from(commandId).toString("base64"), timestamp: new Date() });
}

test("proxy violations are recognized and seatbelt lines are not", () => {
  // arrange
  const proxyLines = ["deny network-outbound example.com:80 (proxy)", "deny http-request example.com:80 (proxy)"];
  const seatbeltLine = "Sandbox: bash(1) deny(1) file-read-data /x";

  // act
  const proxy = proxyLines.map(isProxyViolation);
  const seatbelt = isProxyViolation(seatbeltLine);

  // assert
  assert.deepEqual(proxy, [true, true]);
  assert.equal(seatbelt, false);
});

test("system noise denials are recognized and other denials are not", () => {
  // arrange
  const noiseLines = [
    "bash(9369) deny(1) sysctl-read kern.iossupportversion",
    "jj(1776) deny(1) mach-lookup com.apple.diagnosticd",
    "jj(1776) deny(1) mach-lookup com.apple.analyticsd",
    "jj(1777) deny(1) system-info vfs.disk-space",
  ];
  const otherLines = [
    "bash(1) deny(1) sysctl-read kern.bootuuid",
    "bash(1) deny(1) sysctl-read kern.iossupportversion_other",
    "jj(1777) deny(1) system-info vfs.disk-space-other",
    "cat(1) deny(1) file-read-data /Users/max/kern.iossupportversion",
  ];

  // act
  const noise = noiseLines.map(isSystemNoise);
  const other = otherLines.map(isSystemNoise);

  // assert
  assert.deepEqual(noise, [true, true, true, true]);
  assert.deepEqual(other, [false, false, false, false]);
});
