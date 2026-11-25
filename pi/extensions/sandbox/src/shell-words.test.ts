import assert from "node:assert/strict";
import test from "node:test";
import { simpleCommands } from "./shell-words.ts";

test("quotes and escapes join words and are removed", () => {
  // arrange
  const command = String.raw`echo 'a b' "c $(d) e" f\ g`;
  const expected = [["echo", "a b", "c $(d) e", "f g"], ["d"]];

  // act
  const commands = simpleCommands(command);

  // assert
  assert.deepEqual(commands, expected);
});

test("operators outside quotes separate simple commands", () => {
  // arrange
  const command = "a && b || c; d | e & (f) |& g 'h; i'";
  const expected = [["a"], ["b"], ["c"], ["d"], ["e"], ["f"], ["g", "h; i"]];

  // act
  const commands = simpleCommands(command);

  // assert
  assert.deepEqual(commands, expected);
});

test("redirections drop their targets and file descriptors", () => {
  // arrange
  const command = "cmd 2>&1 >out <in &>>log <<<here arg";
  const expected = [["cmd", "arg"]];

  // act
  const commands = simpleCommands(command);

  // assert
  assert.deepEqual(commands, expected);
});

test("here-document bodies are skipped", () => {
  // arrange
  const command = "cat <<'EOF' > file\nbazel build\nEOF\nnext <<-END\n\tbazel test\n\tEND\nlast";
  const expected = [["cat"], ["next"], ["last"]];

  // act
  const commands = simpleCommands(command);

  // assert
  assert.deepEqual(commands, expected);
});

test("comments run to the end of the line", () => {
  // arrange
  const command = "a # b; c\nd#e";
  const expected = [["a"], ["d#e"]];

  // act
  const commands = simpleCommands(command);

  // assert
  assert.deepEqual(commands, expected);
});

test("command substitutions are simple commands of their own", () => {
  // arrange
  const command = 'echo $(a `b` "$(c)") `d`';
  const expected = ["echo", "a", "b", "c", "d"];

  // act
  const programs = simpleCommands(command).map((words) => words[0]);

  // assert
  assert.deepEqual(programs, expected);
});

test("other whitespace stays inside words", () => {
  // arrange
  const command = "a\r\nb\fc";
  const expected = [["a\r"], ["b\fc"]];

  // act
  const commands = simpleCommands(command);

  // assert
  assert.deepEqual(commands, expected);
});

test("a line continuation joins two lines into one command", () => {
  // arrange
  const command = "bazel \\\n  build";
  const expected = [["bazel", "build"]];

  // act
  const commands = simpleCommands(command);

  // assert
  assert.deepEqual(commands, expected);
});
