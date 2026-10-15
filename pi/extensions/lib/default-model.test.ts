import assert from "node:assert/strict";
import test from "node:test";
import {
  choosesModelOnCommandLine,
  configuredDefaultModel,
  DefaultModelOutcome,
  fallbackWarning,
  isSameModel,
} from "./default-model.ts";

const configured = { provider: "pi-claude", id: "claude-sonnet-5-5" };
const fallback = { provider: "openai-codex", id: "gpt-6.1-sol" };

test("configuredDefaultModel returns the reference when both settings are strings", () => {
  // arrange
  const settings = { defaultProvider: "pi-claude", defaultModel: "claude-sonnet-5-5" };

  // act
  const result = configuredDefaultModel(settings);

  // assert
  assert.deepEqual(result, configured);
});

test("configuredDefaultModel returns undefined without a defaultModel", () => {
  // arrange
  const settings = { defaultProvider: "pi-claude" };

  // act
  const result = configuredDefaultModel(settings);

  // assert
  assert.equal(result, undefined);
});

test("configuredDefaultModel returns undefined for a non-string defaultProvider", () => {
  // arrange
  const settings = { defaultProvider: 7, defaultModel: "claude-sonnet-5-5" };

  // act
  const result = configuredDefaultModel(settings);

  // assert
  assert.equal(result, undefined);
});

test("--model on the command line counts as an explicit choice", () => {
  // arrange
  const argv = ["node", "pi", "--model", "x"];

  // act
  const result = choosesModelOnCommandLine(argv);

  // assert
  assert.equal(result, true);
});

test("--models on the command line counts as an explicit choice", () => {
  // arrange
  const argv = ["node", "pi", "--models", "a,b"];

  // act
  const result = choosesModelOnCommandLine(argv);

  // assert
  assert.equal(result, true);
});

test("unrelated flags are not an explicit model choice", () => {
  // arrange
  const argv = ["node", "pi", "-c"];

  // act
  const result = choosesModelOnCommandLine(argv);

  // assert
  assert.equal(result, false);
});

test("isSameModel matches provider and id", () => {
  // arrange
  const active = { provider: "pi-claude", id: "claude-sonnet-5-5" };

  // act
  const result = isSameModel(active, configured);

  // assert
  assert.equal(result, true);
});

test("isSameModel rejects the same id under a different provider", () => {
  // arrange
  const active = { provider: "other", id: "claude-sonnet-5-5" };

  // act
  const result = isSameModel(active, configured);

  // assert
  assert.equal(result, false);
});

test("isSameModel rejects a missing active model", () => {
  // arrange
  const active = undefined;

  // act
  const result = isSameModel(active, configured);

  // assert
  assert.equal(result, false);
});

test("fallbackWarning reports a missing default model", () => {
  // arrange
  const outcome = DefaultModelOutcome.Missing;

  // act
  const result = fallbackWarning(configured, fallback, outcome);

  // assert
  assert.equal(
    result,
    "Default model pi-claude/claude-sonnet-5-5 was not found. Using openai-codex/gpt-6.1-sol.",
  );
});

test("fallbackWarning reports a default model without auth", () => {
  // arrange
  const outcome = DefaultModelOutcome.NoAuth;

  // act
  const result = fallbackWarning(configured, fallback, outcome);

  // assert
  assert.equal(
    result,
    "Default model pi-claude/claude-sonnet-5-5 has no auth configured. Using openai-codex/gpt-6.1-sol.",
  );
});

test("fallbackWarning reports a successful switch", () => {
  // arrange
  const outcome = DefaultModelOutcome.Switched;

  // act
  const result = fallbackWarning(configured, fallback, outcome);

  // assert
  assert.equal(
    result,
    "Default model pi-claude/claude-sonnet-5-5 was not ready at startup, so pi picked openai-codex/gpt-6.1-sol. Switched to pi-claude/claude-sonnet-5-5.",
  );
});

test("fallbackWarning reports a failed switch", () => {
  // arrange
  const outcome = DefaultModelOutcome.SwitchFailed;

  // act
  const result = fallbackWarning(configured, fallback, outcome);

  // assert
  assert.equal(
    result,
    "Default model pi-claude/claude-sonnet-5-5 was not ready at startup and switching to it failed. Using openai-codex/gpt-6.1-sol.",
  );
});

test("fallbackWarning names no model when none is active", () => {
  // arrange
  const outcome = DefaultModelOutcome.Missing;

  // act
  const result = fallbackWarning(configured, undefined, outcome);

  // assert
  assert.equal(result, "Default model pi-claude/claude-sonnet-5-5 was not found. Using no model.");
});
