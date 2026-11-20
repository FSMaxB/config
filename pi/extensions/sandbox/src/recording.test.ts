import assert from "node:assert/strict";
import test from "node:test";
import { exact, tree } from "../../lib/path-permission-rules.ts";
import type { EffectivePolicy } from "../../lib/path-permissions.ts";
import { buildDraft, draftText, parseDraftText, traceAccesses } from "./recording.ts";
import type { DraftInput, TraceAccess } from "./recording.ts";

const HOME = "/Users/max";


test("trace accesses parse read and write operations and ignore other operations", () => {
  // arrange
  const lines = [
    "cat(66048) allow file-read-data /private/etc/shells",
    "cat(66048) allow file-read-data /private/etc/shells",
    "touch(7) allow file-write-create /private/var/tmp/x",
    "touch(7) allow file-ioctl /dev/tty",
    "sysctl(7) allow sysctl-read kern.version",
    "ls(7) allow file-read-metadata /Users/max/My Dir/file",
  ];

  // act
  const accesses = traceAccesses(lines);

  // assert
  assert.deepEqual(accesses, [read("/private/etc/shells"), write("/private/var/tmp/x"), read("/Users/max/My Dir/file")]);
});

test("accesses in the repository, covered by the policy, the toolchain or the profile are dropped", () => {
  // arrange
  const accesses = [
    read(`${HOME}/repo/src/a`),
    write(`${HOME}/repo/out/b`),
    read("/opt/allowed/x"),
    read(`${HOME}/.cargo/registry/y`),
    write("/profile/dir/z"),
    read("/opt/new/q"),
  ];
  const draft = buildDraft(input(accesses, {
    policy: policy({ readAllow: [tree("/opt/allowed")] }),
    toolchainRead: [`${HOME}/.cargo`, `${HOME}/.Global*`],
    existing: { read: [], write: [tree("/profile/dir")] },
  }));

  // act
  const entries = draft.entries;

  // assert
  assert.deepEqual(entries, [{ mode: "read", directory: "/opt/new" }]);
});

test("secrets and protected writes are set aside, not drafted", () => {
  // arrange
  const protectedRoot = tree(`${HOME}/.pi/agent/extensions`);
  const accesses = [read(`${HOME}/.netrc`), write(`${HOME}/.pi/agent/extensions/foo`), read("/opt/new/q")];

  // act
  const draft = buildDraft(input(accesses, { policy: policy({ writeAllow: [tree(`${HOME}/.pi/agent`)], protectedWrites: [protectedRoot] }) }));

  // assert
  assert.deepEqual(draft.entries, [{ mode: "read", directory: "/opt/new" }]);
  assert.deepEqual(draft.secrets, [read(`${HOME}/.netrc`)]);
  assert.deepEqual(draft.protected, [write(`${HOME}/.pi/agent/extensions/foo`)]);
});

test("a directory access keeps the directory and a file access its parent", () => {
  // arrange
  const accesses = [read("/opt/tool/lib"), read("/opt/other/file.txt")];

  // act
  const draft = buildDraft(input(accesses, { directories: new Set(["/opt/tool/lib"]) }));

  // assert
  assert.deepEqual(draft.entries, [{ mode: "read", directory: "/opt/other" }, { mode: "read", directory: "/opt/tool/lib" }]);
});

test("three siblings collapse into their parent", () => {
  // arrange
  const accesses = [write("/private/var/tmp/_bazel/a/f"), write("/private/var/tmp/_bazel/b/f"), write("/private/var/tmp/_bazel/c/f")];

  // act
  const draft = buildDraft(input(accesses));

  // assert
  assert.deepEqual(draft.entries, [{ mode: "write", directory: "/private/var/tmp/_bazel" }]);
});

test("two siblings do not collapse", () => {
  // arrange
  const accesses = [write("/private/var/tmp/_bazel/a/f"), write("/private/var/tmp/_bazel/b/f")];

  // act
  const draft = buildDraft(input(accesses));

  // assert
  assert.deepEqual(draft.entries.map(({ directory }) => directory), ["/private/var/tmp/_bazel/a", "/private/var/tmp/_bazel/b"]);
});

test("the collapse never reaches a root, the home directory or its first level", () => {
  // arrange
  const accesses = [
    read("/private/var/a/f"), read("/private/var/b/f"), read("/private/var/c/f"),
    read(`${HOME}/Library/a/f`), read(`${HOME}/Library/b/f`), read(`${HOME}/Library/c/f`),
    read(`${HOME}/x/f`), read(`${HOME}/y/f`), read(`${HOME}/z/f`),
  ];

  // act
  const directories = buildDraft(input(accesses)).entries.map(({ directory }) => directory);

  // assert
  assert.equal(directories.length, 9);
  assert.ok(!directories.includes("/private/var") && !directories.includes(`${HOME}/Library`) && !directories.includes(HOME));
});

test("a collapsed parent can collapse again and nested entries are dropped", () => {
  // arrange
  const accesses = [
    read(`${HOME}/Library/Caches/a/1/f`), read(`${HOME}/Library/Caches/a/2/f`), read(`${HOME}/Library/Caches/a/3/f`),
    read(`${HOME}/Library/Caches/b/1/f`), read(`${HOME}/Library/Caches/b/2/f`), read(`${HOME}/Library/Caches/b/3/f`),
    read(`${HOME}/Library/Caches/c/1/f`), read(`${HOME}/Library/Caches/c/2/f`), read(`${HOME}/Library/Caches/c/3/f`),
    read(`${HOME}/Library/Caches/c/top`),
  ];

  // act
  const draft = buildDraft(input(accesses));

  // assert
  assert.deepEqual(draft.entries, [{ mode: "read", directory: `${HOME}/Library/Caches` }]);
});

test("the draft text round-trips through the parser", () => {
  // arrange
  const draft = buildDraft(input([read(`${HOME}/Library/Caches/bazelisk/x/f`), write("/private/var/tmp/out/f"), read(`${HOME}/.netrc`)]));
  const text = draftText(draft, { profile: "bazel", commands: ["bazel build //app", "bazel test\n//x"], accessCount: 3 }, HOME);

  // act
  const parsed = parseDraftText(text);

  // assert
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.entries, [
    { mode: "read", entry: "~/Library/Caches/bazelisk/x/**" },
    { mode: "write", entry: "/private/var/tmp/out/**" },
  ]);
  assert.match(text, /# Recording for profile "bazel": 2 commands, 3 accesses/);
  assert.match(text, /# {3}!bazel test …/);
  assert.match(text, /# secret, only filesystem\.secretRead in the profile file can grant it \(reads only\): read ~\/\.netrc/);
});

test("bad lines are reported with their number and good lines survive", () => {
  // arrange
  const text = ["# comment", "", "write ~/ok/**", "grant /x", "read relative/path", "read /abs"].join("\n");

  // act
  const parsed = parseDraftText(text);

  // assert
  assert.deepEqual(parsed.entries, [{ mode: "write", entry: "~/ok/**" }, { mode: "read", entry: "/abs" }]);
  assert.equal(parsed.errors.length, 2);
  assert.match(parsed.errors[0], /^line 4:/);
  assert.match(parsed.errors[1], /^line 5:/);
});

test("exact selectors in the existing profile entries also silence accesses", () => {
  // arrange
  const accesses = [read("/opt/one/file")];

  // act
  const draft = buildDraft(input(accesses, { existing: { read: [exact("/opt/one/file")], write: [] } }));

  // assert
  assert.deepEqual(draft.entries, []);
});

function input(accesses: TraceAccess[], overrides: Partial<DraftInput> = {}): DraftInput {
  return {
    accesses,
    directories: new Set(),
    policy: policy(),
    toolchainRead: [],
    existing: { read: [], write: [] },
    secrets: [`${HOME}/.ssh`, `${HOME}/.netrc`],
    repositoryRoot: `${HOME}/repo`,
    homeDirectory: HOME,
    ...overrides,
  };
}

function policy(overrides: Partial<{ readAllow: ReturnType<typeof tree>[]; writeAllow: ReturnType<typeof tree>[]; protectedWrites: ReturnType<typeof tree>[] }> = {}): EffectivePolicy {
  return {
    read: { allow: overrides.readAllow ?? [], deny: [], protected: [] },
    write: { allow: overrides.writeAllow ?? [], deny: [], protected: overrides.protectedWrites ?? [] },
  };
}

function read(path: string): TraceAccess {
  return { mode: "read", path };
}

function write(path: string): TraceAccess {
  return { mode: "write", path };
}
