import assert from "node:assert/strict";
import { test } from "node:test";
import { watchAttended, whileAttended } from "./attended-prompts.ts";
import type { AttendedEventBus } from "./attended-prompts.ts";

test("a watch reports attended while the action runs", async () => {
  // arrange
  const bus = fakeBus();
  const watch = watchAttended(bus);

  // act
  const during = await whileAttended(bus, () => Promise.resolve(watch.isAttended()));

  // assert
  assert.equal(during, true);
});

test("a watch reports unattended after the action resolves", async () => {
  // arrange
  const bus = fakeBus();
  const watch = watchAttended(bus);

  // act
  await whileAttended(bus, () => Promise.resolve());

  // assert
  assert.equal(watch.isAttended(), false);
});

test("a watch reports unattended after the action rejects", async () => {
  // arrange
  const bus = fakeBus();
  const watch = watchAttended(bus);

  // act
  await assert.rejects(whileAttended(bus, () => Promise.reject(new Error("picker failed"))));

  // assert
  assert.equal(watch.isAttended(), false);
});

test("an outer attended run stays attended after an inner one ends", async () => {
  // arrange
  const bus = fakeBus();
  const watch = watchAttended(bus);

  // act
  const afterInner = await whileAttended(bus, async () => {
    await whileAttended(bus, () => Promise.resolve());
    return watch.isAttended();
  });

  // assert
  assert.equal(afterInner, true);
});

test("an end signal without a start does not make the next run unattended", async () => {
  // arrange
  const bus = fakeBus();
  const watch = watchAttended(bus);
  bus.emit("config:prompt:attended", { phase: "end" });

  // act
  const during = await whileAttended(bus, () => Promise.resolve(watch.isAttended()));

  // assert
  assert.equal(during, true);
});

function fakeBus(): AttendedEventBus {
  const handlers = new Map<string, ((data: unknown) => void)[]>();
  return {
    emit: (channel, data) => {
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
    on: (channel, handler) => {
      handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
      return () => {};
    },
  };
}
