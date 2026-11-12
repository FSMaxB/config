import assert from "node:assert/strict";
import { test } from "node:test";
import { PauseGate } from "./gate.ts";

const POLL_INTERVAL_MS = 1;

test("a second toggle cancels a requested pause", () => {
  // arrange
  const gate = new PauseGate();
  gate.toggle();

  // act
  gate.toggle();

  // assert
  assert.equal(gate.state, "running");
});

test("hold stays paused until released", async () => {
  // arrange
  const gate = new PauseGate();
  gate.toggle();

  // act
  const held = gate.hold({ signal: undefined, hasPendingMessages: () => false, pollIntervalMs: POLL_INTERVAL_MS });
  const outcome = await Promise.race([
    held.then(() => "released"),
    new Promise((resolve) => setTimeout(() => resolve("still held"), 20)),
  ]);

  // assert
  assert.equal(outcome, "still held");
  assert.equal(gate.state, "paused");
  gate.reset();
});

test("hold resolves when toggled again", async () => {
  // arrange
  const gate = new PauseGate();
  gate.toggle();
  const held = gate.hold({ signal: undefined, hasPendingMessages: () => false, pollIntervalMs: POLL_INTERVAL_MS });

  // act
  gate.toggle();
  await held;

  // assert
  assert.equal(gate.state, "running");
});

test("hold resolves when a user message is queued", async () => {
  // arrange
  const gate = new PauseGate();
  gate.toggle();
  let pending = false;
  const held = gate.hold({ signal: undefined, hasPendingMessages: () => pending, pollIntervalMs: POLL_INTERVAL_MS });

  // act
  pending = true;
  await held;

  // assert
  assert.equal(gate.state, "running");
});

test("hold resolves when the run is aborted", async () => {
  // arrange
  const gate = new PauseGate();
  gate.toggle();
  const controller = new AbortController();
  const held = gate.hold({
    signal: controller.signal,
    hasPendingMessages: () => false,
    pollIntervalMs: POLL_INTERVAL_MS,
  });

  // act
  controller.abort();
  await held;

  // assert
  assert.equal(gate.state, "running");
});

test("hold resolves at once for an already aborted run", async () => {
  // arrange
  const gate = new PauseGate();
  gate.toggle();
  const controller = new AbortController();
  controller.abort();

  // act
  await gate.hold({ signal: controller.signal, hasPendingMessages: () => false, pollIntervalMs: POLL_INTERVAL_MS });

  // assert
  assert.equal(gate.state, "running");
});

test("reset releases a hold", async () => {
  // arrange
  const gate = new PauseGate();
  gate.toggle();
  const held = gate.hold({ signal: undefined, hasPendingMessages: () => false, pollIntervalMs: POLL_INTERVAL_MS });

  // act
  gate.reset();
  await held;

  // assert
  assert.equal(gate.state, "running");
});
