import assert from "node:assert/strict";
import test from "node:test";
import { PathRuleStore } from "./agent-mode.ts";
import { parsePathsArgument, pathsCompletions } from "./paths-command.ts";

test("no argument lists the active mode's rules", () => {
  // arrange
  const argument = "";

  // act
  const command = parsePathsArgument(argument, PathRuleStore.Plan);

  // assert
  assert.deepEqual(command, { kind: "grants", store: "plan" });
});

test("a bare mode name lists that mode's rules", () => {
  // arrange
  const argument = "explore";

  // act
  const command = parsePathsArgument(argument, PathRuleStore.Execution);

  // assert
  assert.deepEqual(command, { kind: "grants", store: "explore" });
});

test("allow without a mode targets the active mode and keeps spaces in the pattern", () => {
  // arrange
  const argument = "allow ~/notes/my file.md";

  // act
  const command = parsePathsArgument(argument, PathRuleStore.Execution);

  // assert
  assert.deepEqual(command, { kind: "rule", store: "execution", ruleKind: "allow", pattern: "~/notes/my file.md" });
});

test("a mode prefix selects another mode's rules", () => {
  // arrange
  const argument = "plan deny /tmp/**";

  // act
  const command = parsePathsArgument(argument, PathRuleStore.Execution);

  // assert
  assert.deepEqual(command, { kind: "rule", store: "plan", ruleKind: "deny", pattern: "/tmp/**" });
});

test("unknown arguments and trailing words after grants are rejected", () => {
  // arrange
  const unknown = "bogus";
  const trailing = "grants extra";

  // act
  const unknownCommand = parsePathsArgument(unknown, PathRuleStore.Execution);
  const trailingCommand = parsePathsArgument(trailing, PathRuleStore.Execution);

  // assert
  assert.equal(unknownCommand, undefined);
  assert.equal(trailingCommand, undefined);
});

test("completions match by prefix and are null without a match", () => {
  // arrange
  const matching = "pl";
  const missing = "x";

  // act
  const matches = pathsCompletions(matching);
  const none = pathsCompletions(missing);

  // assert
  assert.deepEqual(matches, [{ value: "plan", label: "plan" }]);
  assert.equal(none, null);
});
