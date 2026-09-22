import assert from "node:assert/strict";
import test from "node:test";
import {
  collectContextMessages,
  measureTranscriptSystem,
  splitContextMessages,
} from "./context-messages.ts";

test("0.85 falls back to entry conversion and retains legacy accounting", () => {
  // arrange
  const user = { role: "user", content: "hello" };
  const manager = { buildContextEntries: () => [user] };

  // act
  const result = splitContextMessages(
    collectContextMessages(manager, (entry) => [entry]),
  );

  // assert
  assert.deepEqual(result, { messages: [user], systemMessages: [] });
});

test("0.87 uses projected replacements and omissions instead of raw entries", () => {
  // arrange
  const replacement = { role: "user", content: "replacement" };
  const manager = {
    buildContextEntries: () => {
      throw new Error("Raw entries must not be used when projection exists");
    },
    buildSessionProjection() {
      assert.equal(this, manager);
      return { messages: [replacement] };
    },
  };

  // act
  const messages = collectContextMessages(manager, () => {
    throw new Error("Individual entry conversion bypasses context edits");
  });

  // assert
  assert.deepEqual(messages, [replacement]);
});

test("an empty 0.87 projection does not fall back to omitted raw messages", () => {
  // arrange
  const manager = {
    buildContextEntries: () => [{ role: "user" }],
    buildSessionProjection: () => ({ messages: [] }),
  };

  // act
  const messages = collectContextMessages(manager, (entry) => [entry]);

  // assert
  assert.deepEqual(messages, []);
});

test("0.86 transcript updates are measured without counting system entries as chat", () => {
  // arrange
  const tool = { name: "read", description: "Read", parameters: {} };
  const removed = [{ name: "read" }];
  const sections = { mode: "plan", removed: null };
  const user = { role: "user", content: "hello" };
  const entries = [
    { role: "system", content: "base", toolsAdded: [tool] },
    user,
    {
      role: "system",
      content: [{ type: "text", text: "update" }],
      sections,
      toolsAdded: [tool],
      toolsRemoved: removed,
    },
  ];

  // act
  const { messages, systemMessages } = splitContextMessages(
    collectContextMessages({ buildContextEntries: () => entries }, (entry) => [
      entry,
    ]),
  );
  const totals = measureTranscriptSystem(systemMessages);

  // assert
  assert.deepEqual(messages, [user]);
  assert.equal(systemMessages.length, 2);
  assert.deepEqual(totals, {
    instructionCharacters: 10 + JSON.stringify(sections).length,
    toolCharacters:
      2 * JSON.stringify(tool).length + JSON.stringify(removed).length,
    toolDeclarations: 2,
  });
});
