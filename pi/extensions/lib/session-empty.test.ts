import assert from "node:assert/strict";
import test from "node:test";
import { sessionIsEmpty } from "./session-empty.ts";

test("a branch with only state, model and hidden entries is empty", () => {
  // arrange
  const entries = [
    { type: "model_change" },
    { type: "custom" },
    { type: "custom_message" },
  ];

  // act
  const result = sessionIsEmpty(entries);

  // assert
  assert.equal(result, true);
});

test("a branch with a user message is not empty", () => {
  // arrange
  const entries = [
    { type: "model_change" },
    { type: "message", message: { role: "user" } },
  ];

  // act
  const result = sessionIsEmpty(entries);

  // assert
  assert.equal(result, false);
});

test("a branch with an assistant message but no user message is not empty", () => {
  // arrange
  const entries = [{ type: "message", message: { role: "assistant" } }];

  // act
  const result = sessionIsEmpty(entries);

  // assert
  assert.equal(result, false);
});

test("a bash execution excluded from the prompt does not make the branch non-empty", () => {
  // arrange
  const entries = [{ type: "message", message: { role: "bashExecution" } }];

  // act
  const result = sessionIsEmpty(entries);

  // assert
  assert.equal(result, true);
});
