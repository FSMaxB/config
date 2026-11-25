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
    "timeout 60 bazel build",
    "timeout -s KILL -k 5 10m bazel test",
    "gtimeout --signal=TERM 5 bazel run",
    "watch -n 5 bazel query //...",
    'watch -n5 "bazel build && echo done"',
    "nice -n 10 bazel build",
    "env -u HOME FOO=1 bazel run",
    "caffeinate -i bazel build",
    "stdbuf -oL bazel build | tee log",
    "find . -name BUILD | xargs -n 1 bazel query",
    "timeout 60 nice -n 5 nohup bazel build",
    "time -p bazel build",
    "exec -a name bazel",
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
  const commands = [
    "echo bazel",
    "grep bazel BUILD",
    "bazelrc-lint",
    "cat bazel.log",
    "echo 'a; bazel build'",
    "cat <<EOF\nbazel build\nEOF",
    "true # bazel build",
    "timeout 5 cat bazel",
    "watch -n 1 cat bazel.log",
    "xargs -I bazel echo bazel",
  ];

  // act
  const matches = commands.map((command) => matchTrigger(command, triggers));

  // assert
  assert.deepEqual(matches, Array(commands.length).fill(undefined));
});

test("command names skip assignments and keywords and include wrappers", () => {
  // arrange
  const command = "A=1 time nohup foo; if bar; then baz; fi";
  const expected = ["time", "nohup", "foo", "bar", "baz", "fi"];

  // act
  const names = commandNames(command);

  // assert
  assert.deepEqual(names, expected);
});
