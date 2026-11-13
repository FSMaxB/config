import assert from "node:assert/strict";
import test from "node:test";
import { destinationKey, effectiveNetwork, emptyGrants, networkConfig, NO_PROFILE_NETWORK, networkDenialNote, networkSessionGrants, parseGrants, recordGrant, recordOnceGrant, releaseOnceGrants, rememberedDecision, serializeGrants, type OnceNetworkGrants } from "./network-grants.ts";
import type { Settings } from "./settings.ts";

const settings: Settings = {
  allowedDomains: ["github.com"],
  deniedDomains: ["evil.example"],
  deniedDomainReasons: new Map(),
  allowUnixSockets: ["/tmp/agent.sock"],
  allowLocalBinding: true,
  toolchainRead: [],
  extraDenyRead: [],
};

test("subagents get no network even when settings and grants allow hosts and sockets", () => {
  // arrange
  const grants = emptyGrants();
  recordGrant(grants, "allow", "example.com", undefined);

  // act
  const config = networkConfig(settings, grants, true, NO_PROFILE_NETWORK);

  // assert
  assert.deepEqual(config, { allowedDomains: [], deniedDomains: ["*"], allowUnixSockets: [], allowLocalBinding: false });
});

test("the main session gets the effective lists and the settings' socket flags", () => {
  // arrange
  const grants = emptyGrants();
  recordGrant(grants, "allow", "example.com", undefined);

  // act
  const config = networkConfig(settings, grants, false, NO_PROFILE_NETWORK);

  // assert
  assert.deepEqual(config, { ...effectiveNetwork(settings, grants), allowUnixSockets: ["/tmp/agent.sock"], allowLocalBinding: true });
});

test("a session deny beats a session allow, which beats a once-answer", () => {
  // arrange
  const grants = emptyGrants();
  grants.deny.set("denied.example", undefined);
  grants.allow.add("denied.example");
  grants.allow.add("allowed.example");
  const once: OnceNetworkGrants = new Map([
    ["denied.example", { decision: "allow", holders: new Set([1]), note: undefined }],
    ["allowed.example", { decision: "deny", holders: new Set([1]), note: undefined }],
    ["once.example", { decision: "allow", holders: new Set([1]), note: undefined }],
  ]);

  // act
  const decisions = ["denied.example", "allowed.example", "once.example", "unknown.example"].map((host) => rememberedDecision(grants, once, host, undefined));

  // assert
  assert.deepEqual(decisions, ["deny", "allow", "allow", undefined]);
});

test("a once-answer given while no command runs is not remembered", () => {
  // arrange
  const once: OnceNetworkGrants = new Map();

  // act
  recordOnceGrant(once, "allow", "example.com", new Set(), undefined);

  // assert
  assert.equal(once.size, 0);
});

test("a once-answer is held until the last command that was running exits", () => {
  // arrange
  const once: OnceNetworkGrants = new Map();
  recordOnceGrant(once, "allow", "example.com", new Set([1, 2]), undefined);

  // act
  releaseOnceGrants(once, 1);
  const afterFirst = rememberedDecision(emptyGrants(), once, "example.com", undefined);
  releaseOnceGrants(once, 2);
  const afterLast = rememberedDecision(emptyGrants(), once, "example.com", undefined);

  // assert
  assert.equal(afterFirst, "allow");
  assert.equal(afterLast, undefined);
});

test("network session grants list sorted allowed hosts before denied ones", () => {
  // arrange
  const grants = emptyGrants();
  recordGrant(grants, "allow", "b.example", undefined);
  recordGrant(grants, "allow", "a.example", undefined);
  recordGrant(grants, "deny", "c.example", undefined);

  // act
  const result = networkSessionGrants(grants);

  // assert
  assert.deepEqual(result, [
    { kind: "network", decision: "allow", host: "a.example" },
    { kind: "network", decision: "allow", host: "b.example" },
    { kind: "network", decision: "deny", host: "c.example" },
  ]);
});

test("an allow for host and port answers only that port", () => {
  // arrange
  const grants = emptyGrants();
  recordGrant(grants, "allow", destinationKey("example.com", 443), undefined);
  const once: OnceNetworkGrants = new Map();

  // act
  const sameDestination = rememberedDecision(grants, once, "example.com", 443);
  const otherPort = rememberedDecision(grants, once, "example.com", 80);
  const withoutPort = rememberedDecision(grants, once, "example.com", undefined);

  // assert
  assert.equal(sameDestination, "allow");
  assert.equal(otherPort, undefined);
  assert.equal(withoutPort, undefined);
});

test("a once-answer for host and port answers only that port", () => {
  // arrange
  const once: OnceNetworkGrants = new Map();
  recordOnceGrant(once, "allow", "example.com:443", new Set([1]), undefined);

  // act
  const sameDestination = rememberedDecision(emptyGrants(), once, "example.com", 443);
  const otherPort = rememberedDecision(emptyGrants(), once, "example.com", 80);

  // assert
  assert.equal(sameDestination, "allow");
  assert.equal(otherPort, undefined);
});

test("an IPv6 literal with a port is bracketed", () => {
  // arrange
  const host = "::1";

  // act
  const key = destinationKey(host, 8080);

  // assert
  assert.equal(key, "[::1]:8080");
});

test("deny reasons survive a serialization round trip and old entries parse without them", () => {
  // arrange
  const grants = emptyGrants();
  recordGrant(grants, "deny", "a.example", "use https");
  recordGrant(grants, "deny", "b.example", undefined);

  // act
  const restored = parseGrants(JSON.parse(JSON.stringify(serializeGrants(grants))));
  const legacy = parseGrants({ allow: [], deny: ["old.example"] });

  // assert
  assert.equal(restored.deny.get("a.example"), "use https");
  assert.equal(restored.deny.has("b.example"), true);
  assert.equal(restored.deny.get("b.example"), undefined);
  assert.deepEqual([...legacy.deny], [["old.example", undefined]]);
});

test("a denial note comes from the once-answer first, then the session, then the settings", () => {
  // arrange
  const grants = emptyGrants();
  recordGrant(grants, "deny", "example.com", "session reason");
  const once: OnceNetworkGrants = new Map([["example.com", { decision: "deny", holders: new Set([1]), note: "once reason" }]]);
  const settingsReasons = new Map([["example.com", "settings reason"], ["other.example", "other settings reason"]]);

  // act
  const withOnce = networkDenialNote({ grants, once, settingsReasons }, "example.com", 80);
  const withoutOnce = networkDenialNote({ grants, once: new Map(), settingsReasons }, "example.com", 80);
  const onlySettings = networkDenialNote({ grants: emptyGrants(), once: new Map(), settingsReasons }, "other.example", 80);
  const unknown = networkDenialNote({ grants, once, settingsReasons }, "unknown.example", 80);

  // assert
  assert.equal(withOnce, "once reason");
  assert.equal(withoutOnce, "session reason");
  assert.equal(onlySettings, "other settings reason");
  assert.equal(unknown, undefined);
});

test("a denial note for host and port is found before the one for the whole host", () => {
  // arrange
  const grants = emptyGrants();
  recordGrant(grants, "deny", "example.com", "whole host");
  recordGrant(grants, "deny", "example.com:80", "port only");

  // act
  const onPort = networkDenialNote({ grants, once: new Map(), settingsReasons: new Map() }, "example.com", 80);
  const elsewhere = networkDenialNote({ grants, once: new Map(), settingsReasons: new Map() }, "example.com", 443);

  // assert
  assert.equal(onPort, "port only");
  assert.equal(elsewhere, "whole host");
});

test("profile network adds hosts and sockets and ORs local binding, but a session deny wins", () => {
  // arrange
  const grants = emptyGrants();
  grants.deny.set("blocked.example", undefined);
  const profile = { allowedDomains: ["bcr.example", "blocked.example"], allowLocalBinding: true, allowUnixSockets: ["/profile.sock"] };
  const quiet = { ...settings, allowLocalBinding: false };

  // act
  const config = networkConfig(quiet, grants, false, profile);

  // assert
  assert.deepEqual(config.allowedDomains, ["github.com", "bcr.example"]);
  assert.ok(config.deniedDomains.includes("blocked.example"));
  assert.deepEqual(config.allowUnixSockets, ["/tmp/agent.sock", "/profile.sock"]);
  assert.equal(config.allowLocalBinding, true);
});

test("subagents ignore profile network", () => {
  // arrange
  const profile = { allowedDomains: ["bcr.example"], allowLocalBinding: true, allowUnixSockets: ["/profile.sock"] };

  // act
  const config = networkConfig(settings, emptyGrants(), true, profile);

  // assert
  assert.deepEqual(config, { allowedDomains: [], deniedDomains: ["*"], allowUnixSockets: [], allowLocalBinding: false });
});
