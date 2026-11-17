import assert from "node:assert/strict";
import test from "node:test";
import { commandNames, matchTrigger } from "./profile-triggers.ts";

const triggers = { commands: ["bazel", "bazelisk"], patterns: ["^\\./tools/build\\.sh"] };

test("commands in command position match", () => {
  // arrange
  const commands = [
    "bazel build //...",
    "cd a && bazel test",
    "FOO=1 env bazel run",
    "/opt/bin/bazel build",
    "echo $(bazel info output_base)",
    "x | bazelisk query",
    "'bazel' build",
  ];

  // act
  const matches = commands.map((command) => matchTrigger(command, triggers)?.kind);

  // assert
  assert.deepEqual(matches, Array(commands.length).fill("command"));
});

test("a pattern matches over the command text", () => {
  // arrange
  const command = "./tools/build.sh --fast";

  // act
  const match = matchTrigger(command, triggers);

  // assert
  assert.deepEqual(match, { kind: "pattern", pattern: "^\\./tools/build\\.sh" });
});

test("arguments and similar names do not match", () => {
  // arrange
  const commands = ["echo bazel", "grep bazel BUILD", "bazelrc-lint", "cat bazel.log"];

  // act
  const matches = commands.map((command) => matchTrigger(command, triggers));

  // assert
  assert.deepEqual(matches, Array(commands.length).fill(undefined));
});

test("command names skip assignments and prefix words in every simple command", () => {
  // arrange
  const command = "A=1 time nohup foo; if bar; then baz; fi";

  // act
  const names = commandNames(command);

  // assert
  assert.deepEqual(names, ["foo", "bar", "baz", "fi"]);
});
