import assert from "node:assert/strict";
import test from "node:test";
import { effectiveNetwork, emptyGrants, networkConfig, recordGrant } from "./network-grants.ts";
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
