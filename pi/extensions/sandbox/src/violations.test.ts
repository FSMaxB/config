import assert from "node:assert/strict";
import test from "node:test";
import { isSecretPath, pathViolations } from "./violations.ts";

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
