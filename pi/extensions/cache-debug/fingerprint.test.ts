import assert from "node:assert/strict";
import { test } from "node:test";
import { fingerprintPayload, SectionKind } from "./fingerprint.ts";

function messagesOf(payload: unknown) {
  const fingerprint = fingerprintPayload(payload);
  assert.ok(fingerprint);
  const section = fingerprint.sections.find(({ key }) => key === "messages");
  assert.ok(section?.items);
  return section.items;
}

test("appending a message keeps the old items as an exact prefix", () => {
  // arrange
  const before = { model: "m", messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] };
  const after = { model: "m", messages: [...before.messages, { role: "user", content: "c" }] };

  // act
  const beforeItems = messagesOf(before);
  const afterItems = messagesOf(after);

  // assert
  assert.deepEqual(fingerprintPayload(before), fingerprintPayload(structuredClone(before)));
  assert.deepEqual(afterItems.slice(0, beforeItems.length), beforeItems);
  assert.equal(afterItems.length, 3);
});

test("changing one message changes only that item hash", () => {
  // arrange
  const original = { messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }] };
  const changed = { messages: [original.messages[0], { role: "assistant", content: "B" }, original.messages[2]] };

  // act
  const originalItems = messagesOf(original);
  const changedItems = messagesOf(changed);

  // assert
  assert.equal(changedItems[0]?.hash, originalItems[0]?.hash);
  assert.notEqual(changedItems[1]?.hash, originalItems[1]?.hash);
  assert.equal(changedItems[2]?.hash, originalItems[2]?.hash);
});

test("moving cache_control between messages changes no hash", () => {
  // arrange
  const marked = { messages: [{ role: "user", content: "a", cache_control: { type: "ephemeral" } }, { role: "user", content: "b" }] };
  const moved = { messages: [{ role: "user", content: "a" }, { role: "user", content: "b", cache_control: { type: "ephemeral" } }] };

  // act
  const markedFingerprint = fingerprintPayload(marked);
  const movedFingerprint = fingerprintPayload(moved);

  // assert
  assert.deepEqual(markedFingerprint, movedFingerprint);
});

test("numbers are parameters and arrays are content", () => {
  // arrange
  const payload = { messages: [{ role: "user", content: "a" }], maxTokens: 1 };

  // act
  const fingerprint = fingerprintPayload(payload);
  const warm = fingerprintPayload({ ...payload, maxTokens: 4096 });

  // assert
  assert.equal(fingerprint?.sections.find(({ key }) => key === "maxTokens")?.kind, SectionKind.Parameter);
  assert.equal(fingerprint?.sections.find(({ key }) => key === "messages")?.kind, SectionKind.Content);
  assert.notEqual(
    fingerprint?.sections.find(({ key }) => key === "maxTokens")?.hash,
    warm?.sections.find(({ key }) => key === "maxTokens")?.hash,
  );
});

test("items are labelled by role, tool name or type", () => {
  // arrange
  const payload = { messages: [{ role: "tool" }, { type: "function", function: { name: "bash" } }, "plain"] };

  // act
  const labels = messagesOf(payload).map(({ label }) => label);

  // assert
  assert.deepEqual(labels, ["tool", "bash", undefined]);
});

test("a payload that is not an object has no fingerprint", () => {
  // arrange
  const payloads = ["x", null, []];

  // act
  const fingerprints = payloads.map(fingerprintPayload);

  // assert
  assert.deepEqual(fingerprints, [undefined, undefined, undefined]);
});

test("the fingerprint contains no content", () => {
  // arrange
  const payload = { messages: [{ role: "user", content: "canary-secret" }], system: "canary-secret" };

  // act
  const serialized = JSON.stringify(fingerprintPayload(payload));

  // assert
  assert.ok(!serialized.includes("canary"));
});
