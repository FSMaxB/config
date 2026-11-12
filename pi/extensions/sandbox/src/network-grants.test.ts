import assert from "node:assert/strict";
import test from "node:test";
import { effectiveNetwork, emptyGrants, networkConfig, recordGrant, recordOnceGrant, releaseOnceGrants, rememberedDecision, type OnceNetworkGrants } from "./network-grants.ts";
import type { Settings } from "./settings.ts";

const settings: Settings = {
  allowedDomains: ["github.com"],
  deniedDomains: ["evil.example"],
  allowUnixSockets: ["/tmp/agent.sock"],
  allowLocalBinding: true,
  toolchainRead: [],
  extraDenyRead: [],
};

test("subagents get no network even when settings and grants allow hosts and sockets", () => {
  // arrange
  const grants = emptyGrants();
  recordGrant(grants, "allow", "example.com");

  // act
  const config = networkConfig(settings, grants, true);

  // assert
  assert.deepEqual(config, { allowedDomains: [], deniedDomains: ["*"], allowUnixSockets: [], allowLocalBinding: false });
});

test("the main session gets the effective lists and the settings' socket flags", () => {
  // arrange
  const grants = emptyGrants();
  recordGrant(grants, "allow", "example.com");

  // act
  const config = networkConfig(settings, grants, false);

  // assert
  assert.deepEqual(config, { ...effectiveNetwork(settings, grants), allowUnixSockets: ["/tmp/agent.sock"], allowLocalBinding: true });
});

test("a session deny beats a session allow, which beats a once-answer", () => {
  // arrange
  const grants = emptyGrants();
  grants.deny.add("denied.example");
  grants.allow.add("denied.example");
  grants.allow.add("allowed.example");
  const once: OnceNetworkGrants = new Map([
    ["denied.example", { decision: "allow", holders: new Set([1]) }],
    ["allowed.example", { decision: "deny", holders: new Set([1]) }],
    ["once.example", { decision: "allow", holders: new Set([1]) }],
  ]);

  // act
  const decisions = ["denied.example", "allowed.example", "once.example", "unknown.example"].map((host) => rememberedDecision(grants, once, host));

  // assert
  assert.deepEqual(decisions, ["deny", "allow", "allow", undefined]);
});

test("a once-answer given while no command runs is not remembered", () => {
  // arrange
  const once: OnceNetworkGrants = new Map();

  // act
  recordOnceGrant(once, "allow", "example.com", new Set());

  // assert
  assert.equal(once.size, 0);
});

test("a once-answer is held until the last command that was running exits", () => {
  // arrange
  const once: OnceNetworkGrants = new Map();
  recordOnceGrant(once, "allow", "example.com", new Set([1, 2]));

  // act
  releaseOnceGrants(once, 1);
  const afterFirst = rememberedDecision(emptyGrants(), once, "example.com");
  releaseOnceGrants(once, 2);
  const afterLast = rememberedDecision(emptyGrants(), once, "example.com");

  // assert
  assert.equal(afterFirst, "allow");
  assert.equal(afterLast, undefined);
});
