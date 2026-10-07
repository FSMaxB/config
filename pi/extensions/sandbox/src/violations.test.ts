import assert from "node:assert/strict";
import test from "node:test";
import { discardedWrites, isSecretPath, pathViolations } from "./violations.ts";

test("macOS read and write violations parse", () => {
  // arrange
  const lines = [
    "Sandbox: cat(1234) deny(1) file-read-data /Users/max/.ssh/config",
    "Sandbox: touch(1235) deny(1) file-write-create /Users/max/x",
  ];

  // act
  const violations = pathViolations(lines);

  // assert
  assert.deepEqual(violations, [
    { mode: "read", path: "/Users/max/.ssh/config" },
    { mode: "write", path: "/Users/max/x" },
  ]);
});

test("a Linux syscall violation is a write", () => {
  // arrange
  const lines = ["deny openat /home/max/x"];

  // act
  const violations = pathViolations(lines);

  // assert
  assert.deepEqual(violations, [{ mode: "write", path: "/home/max/x" }]);
});

test("network and non-file violations are skipped", () => {
  // arrange
  const lines = [
    "deny network-outbound example.com:443 (not allowed)",
    "Sandbox: curl(1) deny(1) network-outbound /private/var/run/socket",
    "Sandbox: sh(1) deny(1) process-exec /Users/max/bin/tool",
    "unrelated output",
  ];

  // act
  const violations = pathViolations(lines);

  // assert
  assert.deepEqual(violations, []);
});

test("duplicate violations collapse and paths with spaces survive", () => {
  // arrange
  const lines = [
    "Sandbox: a(1) deny(1) file-write-create /Users/max/Library/Application Support/x",
    "Sandbox: a(1) deny(1) file-write-data /Users/max/Library/Application Support/x",
  ];

  // act
  const violations = pathViolations(lines);

  // assert
  assert.deepEqual(violations, [{ mode: "write", path: "/Users/max/Library/Application Support/x" }]);
});

test("a write inside a read-denied tree and outside every write allow is a discarded write", () => {
  // arrange
  const filesystem = { denyRead: ["/home", "/home/max"], allowWrite: ["/home/max/repo"] };

  // act
  const reported = discardedWrites([{ mode: "write", path: "/home/max/notes.txt" }], filesystem);

  // assert
  assert.deepEqual(reported, [{ mode: "write", path: "/home/max/notes.txt" }]);
});

test("writes outside the read-denied tree, inside a write allow, and reads are not discarded writes", () => {
  // arrange
  const filesystem = { denyRead: ["/home", "/home/max"], allowWrite: ["/home/max/repo"] };

  // act
  const reported = discardedWrites([
    { mode: "write", path: "/home/max/repo/a" },
    { mode: "write", path: "/dev/null" },
    { mode: "write", path: "/tmp/claude/x" },
    { mode: "read", path: "/home/max/x" },
  ], filesystem);

  // assert
  assert.deepEqual(reported, []);
});

test("a secret path matches itself and nested paths only", () => {
  // arrange
  const secrets = ["/Users/max/.ssh"];

  // act
  const same = isSecretPath("/Users/max/.ssh", secrets);
  const nested = isSecretPath("/Users/max/.ssh/keys/id_ed25519", secrets);
  const sibling = isSecretPath("/Users/max/.sshx/config", secrets);

  // assert
  assert.equal(same, true);
  assert.equal(nested, true);
  assert.equal(sibling, false);
});
