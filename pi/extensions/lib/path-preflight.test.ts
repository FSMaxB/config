import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emptyRules, selectorKey, tree, type RuleSets } from "./path-permission-rules.ts";
import type { PathAuthorization } from "./path-permissions.ts";
import { preflightPath } from "./path-preflight.ts";

test("symlinks pointing outside the authorized root do not fail the preflight", async () => {
  // arrange
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "pi-path-preflight-")));
  const root = join(fixture, "repo");
  const outside = join(fixture, "outside");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "outside\n");
  await symlink(outside, join(root, "bazel-out"));
  await symlink(join(outside, "secret.txt"), join(root, "src", "link.txt"));
  await symlink(join(fixture, "missing"), join(root, "dangling"));

  try {
    // act & assert
    await assert.doesNotReject(preflightPath(authorizationFor(root, emptyRules()), "recursive"));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("a denied real descendant fails the preflight and is named in the error", async () => {
  // arrange
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "pi-path-preflight-")));
  const root = join(fixture, "repo");
  const denied = join(root, "src", "private");
  await mkdir(denied, { recursive: true });
  await writeFile(join(denied, "key.txt"), "secret\n");
  const session = emptyRules();
  session.read.deny.add(selectorKey(tree(denied)));

  try {
    // act & assert
    await assert.rejects(preflightPath(authorizationFor(root, session), "recursive"), (error: Error) => {
      assert.match(error.message, new RegExp(`rejected ${denied} \\(denied by the path rules\\)`));
      return true;
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("the children scope does not descend into subdirectories", async () => {
  // arrange
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "pi-path-preflight-")));
  const root = join(fixture, "repo");
  const denied = join(root, "src", "private");
  await mkdir(denied, { recursive: true });
  const session = emptyRules();
  session.read.deny.add(selectorKey(tree(denied)));

  try {
    // act & assert
    await assert.doesNotReject(preflightPath(authorizationFor(root, session), "children"));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("the recursive walk does not descend into version control internals", async () => {
  // arrange
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "pi-path-preflight-")));
  const root = join(fixture, "repo");
  const gitObjects = join(root, ".git", "objects");
  const jjStore = join(root, ".jj", "repo", "store");
  await mkdir(gitObjects, { recursive: true });
  await mkdir(jjStore, { recursive: true });
  const session = emptyRules();
  session.read.deny.add(selectorKey(tree(gitObjects)));
  session.read.deny.add(selectorKey(tree(jjStore)));

  try {
    // act & assert
    await assert.doesNotReject(preflightPath(authorizationFor(root, session), "recursive"));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("denying a version control directory itself still fails the preflight", async () => {
  // arrange
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "pi-path-preflight-")));
  const root = join(fixture, "repo");
  const gitDirectory = join(root, ".git");
  await mkdir(gitDirectory, { recursive: true });
  const session = emptyRules();
  session.read.deny.add(selectorKey(tree(gitDirectory)));

  try {
    // act & assert
    await assert.rejects(preflightPath(authorizationFor(root, session), "recursive"), new RegExp(`rejected ${gitDirectory} `));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

function authorizationFor(root: string, session: RuleSets): PathAuthorization {
  return {
    operationPath: root,
    checkedPaths: [root],
    mode: "read",
    context: {} as PathAuthorization["context"],
    defaults: [tree(root)],
    session,
    always: emptyRules(),
  };
}
