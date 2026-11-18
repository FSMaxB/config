import assert from "node:assert/strict";
import test from "node:test";
import { chooseShell, parseBashVersion, shellCandidates } from "./shell.ts";

test("parseBashVersion reads major and minor", () => {
  // arrange, act, assert
  assert.deepEqual(parseBashVersion("5.3\n"), { major: 5, minor: 3 });
  assert.deepEqual(parseBashVersion("3.2\n"), { major: 3, minor: 2 });
});

test("parseBashVersion rejects output that is not a version", () => {
  // arrange, act, assert
  assert.equal(parseBashVersion(""), undefined);
  assert.equal(parseBashVersion("GNU bash"), undefined);
});

test("chooseShell picks the first supported entry", () => {
  // arrange
  const probed = [
    { path: "/bin/bash", version: { major: 3, minor: 2 } },
    { path: "/opt/homebrew/bin/bash", version: { major: 5, minor: 3 } },
  ];

  // act
  const choice = chooseShell(probed);

  // assert
  assert.deepEqual(choice, { kind: "found", path: "/opt/homebrew/bin/bash" });
});

test("chooseShell accepts exactly 5.1 and rejects 5.0", () => {
  // arrange
  const exact = [{ path: "/a/bash", version: { major: 5, minor: 1 } }];
  const older = [{ path: "/b/bash", version: { major: 5, minor: 0 } }];

  // act
  const accepted = chooseShell(exact);
  const rejected = chooseShell(older);

  // assert
  assert.deepEqual(accepted, { kind: "found", path: "/a/bash" });
  assert.deepEqual(rejected, { kind: "missing", checked: ["/b/bash"] });
});

test("chooseShell reports every checked path when none is supported", () => {
  // arrange
  const probed = [
    { path: "/bin/bash", version: { major: 3, minor: 2 } },
    { path: "/usr/local/bin/bash", version: undefined },
  ];

  // act
  const choice = chooseShell(probed);

  // assert
  assert.deepEqual(choice, { kind: "missing", checked: ["/bin/bash", "/usr/local/bin/bash"] });
});

test("shellCandidates lists PATH first without empty entries or duplicates, then the well-known paths", () => {
  // arrange
  const environmentPath = "/a:/b::/opt/homebrew/bin";

  // act
  const candidates = shellCandidates(environmentPath);

  // assert
  assert.deepEqual(candidates, ["/a/bash", "/b/bash", "/opt/homebrew/bin/bash", "/usr/local/bin/bash"]);
});

test("shellCandidates without PATH lists the well-known paths", () => {
  // arrange, act
  const candidates = shellCandidates(undefined);

  // assert
  assert.deepEqual(candidates, ["/opt/homebrew/bin/bash", "/usr/local/bin/bash"]);
});
