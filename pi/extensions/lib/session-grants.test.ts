import assert from "node:assert/strict";
import test from "node:test";
import { announceSessionGrantsChanged, collectSessionGrants, onSessionGrantsChanged, provideSessionGrants } from "./session-grants.ts";
import type { GrantEventBus, SessionGrant } from "./session-grants.ts";

const network: SessionGrant = { kind: "network", decision: "allow", host: "example.com" };
const tool: SessionGrant = { kind: "tool", decision: "deny", name: "fetch_content" };
const unsandboxed: SessionGrant = { kind: "unsandboxed", decision: "allow" };

test("collecting without providers returns nothing", () => {
  // arrange
  const bus = fakeBus();

  // act
  const grants = collectSessionGrants(bus);

  // assert
  assert.deepEqual(grants, []);
});

test("collecting concatenates providers in registration order", () => {
  // arrange
  const bus = fakeBus();
  provideSessionGrants(bus, () => [network, tool]);
  provideSessionGrants(bus, () => [unsandboxed]);

  // act
  const grants = collectSessionGrants(bus);

  // assert
  assert.deepEqual(grants, [network, tool, unsandboxed]);
});

test("a provider is asked again on every collect", () => {
  // arrange
  const bus = fakeBus();
  let current: SessionGrant[] = [network];
  provideSessionGrants(bus, () => current);

  // act
  const first = collectSessionGrants(bus);
  current = [tool];
  const second = collectSessionGrants(bus);

  // assert
  assert.deepEqual(first, [network]);
  assert.deepEqual(second, [tool]);
});

test("announcing a change calls every change handler once", () => {
  // arrange
  const bus = fakeBus();
  const calls: string[] = [];
  onSessionGrantsChanged(bus, () => calls.push("first"));
  onSessionGrantsChanged(bus, () => calls.push("second"));

  // act
  announceSessionGrantsChanged(bus);

  // assert
  assert.deepEqual(calls, ["first", "second"]);
});

function fakeBus(): GrantEventBus {
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
