import assert from "node:assert/strict";
import test from "node:test";
import { exact, glob, tree } from "../../lib/path-permission-rules.ts";
import { addAllowedDomain, addFilesystemEntry, emptyProfileDefinition, mergedProfileNetwork, parseActivationDecisions, parseProfileDefinition, parseProfiles, profileFingerprint, recordActivationDecision, selectorText, serializeActivationDecisions, type Profile } from "./profiles.ts";

function profile(name: string, overrides: Partial<Profile> = {}): Profile {
  return { name, ...emptyProfileDefinition(), ...overrides };
}

test("missing keys default to an empty profile", () => {
  // arrange
  const value = { bazel: {} };

  // act
  const profiles = parseProfiles(value);

  // assert
  assert.deepEqual(profiles, [{ name: "bazel", ...emptyProfileDefinition() }]);
});

test("profiles are sorted by name", () => {
  // arrange
  const value = { zeta: {}, alpha: {} };

  // act
  const names = parseProfiles(value).map(({ name }) => name);

  // assert
  assert.deepEqual(names, ["alpha", "zeta"]);
});

test("a missing profiles key yields no profiles", () => {
  // arrange, act, assert
  assert.deepEqual(parseProfiles(undefined), []);
});

test("invalid definitions throw with the profile name", () => {
  // arrange
  const cases: [string, unknown, RegExp][] = [
    ["Bad_Name", {}, /profiles\.Bad_Name/],
    ["bazel", { filesystem: { read: ["/ok", "/ok", "relative"] } }, /profiles\.bazel\.filesystem\.read\[2\] must start with \/ or ~\//],
    ["bazel", { path: ["bin"] }, /profiles\.bazel\.path\[0\]/],
    ["bazel", { triggers: { patterns: ["("] } }, /profiles\.bazel\.triggers\.patterns\[0\]/],
    ["bazel", { network: { allowLocalBinding: "yes" } }, /profiles\.bazel\.network\.allowLocalBinding must be a boolean/],
  ];

  for (const [name, value, message] of cases) {
    // act, assert
    assert.throws(() => parseProfileDefinition(value, name), message);
  }
});

test("the fingerprint ignores triggers and changes with the write paths", () => {
  // arrange
  const base = profile("bazel", { filesystem: { read: [], write: ["/a"] } });
  const retriggered = profile("bazel", { filesystem: { read: [], write: ["/a"] }, triggers: { commands: ["bazel"], patterns: [] } });
  const rewritten = profile("bazel", { filesystem: { read: [], write: ["/b"] } });

  // act
  const fingerprints = [base, retriggered, rewritten].map((entry) => profileFingerprint([entry]));

  // assert
  assert.equal(fingerprints[0], fingerprints[1]);
  assert.notEqual(fingerprints[0], fingerprints[2]);
  assert.match(fingerprints[0], /^[0-9a-f]{16}$/);
});

test("the fingerprint of no profiles is empty and independent of order", () => {
  // arrange
  const first = profile("a", { path: ["/x"] });
  const second = profile("b", { path: ["/y"] });

  // act, assert
  assert.equal(profileFingerprint([]), "");
  assert.equal(profileFingerprint([first, second]), profileFingerprint([second, first]));
});

test("a missing profileActivation key yields empty decisions", () => {
  // arrange, act
  const decisions = parseActivationDecisions(undefined);

  // assert
  assert.equal(decisions.allowed.size, 0);
  assert.equal(decisions.denied.size, 0);
});

test("activation reasons are kept only for denied names", () => {
  // arrange
  const value = { allowed: ["a"], denied: ["b", "c"], deniedReasons: { a: "ignored", b: "no network" } };

  // act
  const decisions = parseActivationDecisions(value);

  // assert
  assert.deepEqual([...decisions.allowed], ["a"]);
  assert.deepEqual([...decisions.denied], [["b", "no network"], ["c", undefined]]);
  assert.deepEqual(serializeActivationDecisions(decisions), { allowed: ["a"], denied: ["b", "c"], deniedReasons: { b: "no network" } });
});

test("the latest activation answer for a name wins", () => {
  // arrange
  const decisions = parseActivationDecisions({ allowed: ["a"], denied: ["b"] });

  // act
  recordActivationDecision(decisions, "a", { decision: "deny", note: "later" });
  recordActivationDecision(decisions, "b", { decision: "allow" });

  // assert
  assert.deepEqual([...decisions.allowed], ["b"]);
  assert.deepEqual([...decisions.denied], [["a", "later"]]);
});

test("merged network unions domains and sockets and ORs local binding", () => {
  // arrange
  const first = profile("a", { network: { allowedDomains: ["x.example", "y.example"], allowLocalBinding: false, allowUnixSockets: ["/s1"] } });
  const second = profile("b", { network: { allowedDomains: ["y.example"], allowLocalBinding: true, allowUnixSockets: ["/s2"] } });

  // act
  const merged = mergedProfileNetwork([first, second]);

  // assert
  assert.deepEqual(merged, { allowedDomains: ["x.example", "y.example"], allowLocalBinding: true, allowUnixSockets: ["/s1", "/s2"] });
});

test("selector text writes the home directory as a tilde", () => {
  // arrange
  const home = "/Users/max";

  // act
  const texts = [tree("/Users/max/cache"), exact("/Users/max/file"), glob("/Users/max/a", "*.log"), tree("/opt/tool"), tree("/Users/maxwell")].map((selector) => selectorText(selector, home));

  // assert
  assert.deepEqual(texts, ["~/cache/**", "~/file", "~/a/*.log", "/opt/tool/**", "/Users/maxwell/**"]);
});

test("adding an entry twice keeps one", () => {
  // arrange
  const definition = emptyProfileDefinition();

  // act
  const once = addFilesystemEntry(definition, "write", "/a/**");
  const twice = addFilesystemEntry(once, "write", "/a/**");
  const domain = addAllowedDomain(addAllowedDomain(twice, "x.example"), "x.example");

  // assert
  assert.deepEqual(twice.filesystem.write, ["/a/**"]);
  assert.deepEqual(domain.network.allowedDomains, ["x.example"]);
});
