import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { effectiveNetwork, emptyGrants, parseGrants, recordGrant, serializeGrants } from "./network-grants.ts";
import { emptyProfileDefinition } from "./profiles.ts";
import { loadActivationDecisions, loadProfiles, loadSettings, parseSettingsFile, resolveSettings, updateActivationDecisions, updateDomainLists, updateProfile } from "./settings.ts";

async function withDirectory<T>(body: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "sandbox-settings-"));
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("a missing settings file yields the defaults", async () => {
  await withDirectory(async (directory) => {
    // arrange
    const filePath = join(directory, "sandbox.json");

    // act
    const settings = await loadSettings(filePath);

    // assert
    assert.ok(settings.allowedDomains.includes("github.com"));
    assert.deepEqual(settings.deniedDomains, []);
    assert.equal(settings.allowLocalBinding, false);
    assert.ok(settings.toolchainRead.includes(join(homedir(), ".cargo")));
  });
});

test("file entries are appended to the defaults and home is expanded", async () => {
  await withDirectory(async (directory) => {
    // arrange
    const filePath = join(directory, "sandbox.json");
    await writeFile(filePath, JSON.stringify({
      network: { allowedDomains: ["example.com"], allowLocalBinding: true },
      filesystem: { allowRead: ["~/.tool"], denyRead: ["~/private"] },
    }));

    // act
    const settings = await loadSettings(filePath);

    // assert
    assert.ok(settings.allowedDomains.includes("github.com"));
    assert.ok(settings.allowedDomains.includes("example.com"));
    assert.equal(settings.allowLocalBinding, true);
    assert.ok(settings.toolchainRead.includes(join(homedir(), ".tool")));
    assert.deepEqual(settings.extraDenyRead, [join(homedir(), "private")]);
  });
});

test("an invalid settings file throws", async () => {
  await withDirectory(async (directory) => {
    // arrange
    const filePath = join(directory, "sandbox.json");
    await writeFile(filePath, JSON.stringify({ network: { allowedDomains: "github.com" } }));
    const malformedPath = join(directory, "malformed.json");
    await writeFile(malformedPath, "{");

    // act: thunks, because a second load started up front would reject while the first
    // is still awaited, and node:test fails the test on that unhandled rejection.
    const wrongShape = () => loadSettings(filePath);
    const malformed = () => loadSettings(malformedPath);

    // assert
    await assert.rejects(wrongShape, /network\.allowedDomains must be an array of strings/);
    await assert.rejects(malformed, /Invalid sandbox settings/);
  });
});

test("parsing rejects non-boolean flags", () => {
  // arrange
  const value = { network: { allowLocalBinding: "yes" } };

  // act
  const parse = () => parseSettingsFile(value);

  // assert
  assert.throws(parse, /allowLocalBinding must be a boolean/);
});

test("updating the domain lists keeps unrelated keys", async () => {
  await withDirectory(async (directory) => {
    // arrange
    const filePath = join(directory, "sandbox.json");
    await writeFile(filePath, JSON.stringify({ note: "keep", network: { allowLocalBinding: true, deniedDomains: ["bad.com"] } }));

    // act
    await updateDomainLists(filePath, ({ allowedDomains, deniedDomains }) => {
      allowedDomains.add("good.com");
      deniedDomains.delete("bad.com");
    });

    // assert
    const written = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(written.note, "keep");
    assert.equal(written.network.allowLocalBinding, true);
    assert.deepEqual(written.network.allowedDomains, ["good.com"]);
    assert.deepEqual(written.network.deniedDomains, []);
  });
});

test("updating the domain lists creates a missing file", async () => {
  await withDirectory(async (directory) => {
    // arrange
    const filePath = join(directory, "nested", "sandbox.json");

    // act
    await updateDomainLists(filePath, ({ allowedDomains }) => { allowedDomains.add("good.com"); });

    // assert
    const settings = await loadSettings(filePath);
    assert.ok(settings.allowedDomains.includes("good.com"));
  });
});

test("session grants override the settings lists", () => {
  // arrange
  const settings = resolveSettings(parseSettingsFile({ network: { allowedDomains: ["stored-allow.com"], deniedDomains: ["stored-deny.com"] } }));
  const grants = emptyGrants();
  recordGrant(grants, "deny", "stored-allow.com", undefined);
  recordGrant(grants, "allow", "stored-deny.com", undefined);
  recordGrant(grants, "allow", "new.com", undefined);

  // act
  const { allowedDomains, deniedDomains } = effectiveNetwork(settings, grants);

  // assert
  assert.ok(!allowedDomains.includes("stored-allow.com"));
  assert.ok(deniedDomains.includes("stored-allow.com"));
  assert.ok(allowedDomains.includes("stored-deny.com"));
  assert.ok(!deniedDomains.includes("stored-deny.com"));
  assert.ok(allowedDomains.includes("new.com"));
});

test("grants survive a serialization round trip", () => {
  // arrange
  const grants = emptyGrants();
  recordGrant(grants, "allow", "a.com", undefined);
  recordGrant(grants, "deny", "b.com", undefined);

  // act
  const restored = parseGrants(serializeGrants(grants));
  const fromGarbage = parseGrants("nonsense");

  // assert
  assert.deepEqual([...restored.allow], ["a.com"]);
  assert.deepEqual([...restored.deny], [["b.com", undefined]]);
  assert.equal(fromGarbage.allow.size, 0);
});

test("deniedDomainReasons parses and rejects non-strings", () => {
  // arrange
  const valid = { network: { deniedDomainReasons: { "example.com:80": "use https" } } };
  const invalid = { network: { deniedDomainReasons: { "example.com": 5 } } };

  // act
  const parsed = parseSettingsFile(valid);
  const parseInvalid = () => parseSettingsFile(invalid);

  // assert
  assert.deepEqual(parsed.network.deniedDomainReasons, { "example.com:80": "use https" });
  assert.throws(parseInvalid, /network\.deniedDomainReasons must be an object of strings/);
  assert.deepEqual(resolveSettings(parsed).deniedDomainReasons, new Map([["example.com:80", "use https"]]));
});

test("updating the domain lists writes deny reasons and keeps other keys", async () => {
  await withDirectory(async (directory) => {
    // arrange
    const filePath = join(directory, "sandbox.json");
    await writeFile(filePath, JSON.stringify({ note: "keep", network: { allowLocalBinding: true, deniedDomainReasons: { "old.com": "old reason" }, deniedDomains: ["old.com"] } }));

    // act
    await updateDomainLists(filePath, ({ deniedDomains, deniedDomainReasons }) => {
      deniedDomains.add("new.com");
      deniedDomainReasons.set("new.com", "new reason");
    });

    // assert
    const written = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(written.note, "keep");
    assert.equal(written.network.allowLocalBinding, true);
    assert.deepEqual(written.network.deniedDomainReasons, { "old.com": "old reason", "new.com": "new reason" });
  });
});

test("updating the domain lists adds no reasons key to files without one", async () => {
  await withDirectory(async (directory) => {
    // arrange
    const filePath = join(directory, "sandbox.json");
    await writeFile(filePath, JSON.stringify({ network: {} }));

    // act
    await updateDomainLists(filePath, ({ allowedDomains }) => { allowedDomains.add("good.com"); });

    // assert
    const written = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal("deniedDomainReasons" in written.network, false);
  });
});

test("a later decision for the same host replaces the earlier one", () => {
  // arrange
  const grants = emptyGrants();
  recordGrant(grants, "allow", "a.com", undefined);

  // act
  recordGrant(grants, "deny", "a.com", undefined);

  // assert
  assert.equal(grants.allow.has("a.com"), false);
  assert.equal(grants.deny.has("a.com"), true);
});

test("loading profiles from a missing file yields none", async () => {
  await withDirectory(async (directory) => {
    // arrange
    const filePath = join(directory, "sandbox.json");

    // act
    const profiles = await loadProfiles(filePath);

    // assert
    assert.deepEqual(profiles, []);
  });
});

test("updating a profile creates, mutates and deletes it while keeping other keys", async () => {
  await withDirectory(async (directory) => {
    // arrange
    const filePath = join(directory, "sandbox.json");
    await writeFile(filePath, JSON.stringify({ network: { allowedDomains: ["a.com"] }, custom: 1 }));

    // act
    await updateProfile(filePath, "bazel", () => emptyProfileDefinition());
    await updateProfile(filePath, "bazel", (current) => current && { ...current, path: ["/bin"] });
    const created = await loadProfiles(filePath);
    await updateProfile(filePath, "bazel", () => undefined);

    // assert
    assert.deepEqual(created.map(({ name, path }) => ({ name, path })), [{ name: "bazel", path: ["/bin"] }]);
    const written = JSON.parse(await readFile(filePath, "utf8"));
    assert.deepEqual(written.network, { allowedDomains: ["a.com"] });
    assert.equal(written.custom, 1);
    assert.deepEqual(written.profiles, {});
  });
});

test("an invalid profile fails the load with its name", async () => {
  await withDirectory(async (directory) => {
    // arrange
    const filePath = join(directory, "sandbox.json");
    await writeFile(filePath, JSON.stringify({ profiles: { bazel: { path: ["relative"] } } }));

    // act, assert
    await assert.rejects(loadProfiles(filePath), /profiles\.bazel\.path\[0\]/);
  });
});

test("updating activation decisions moves a name between the lists and keeps other keys", async () => {
  await withDirectory(async (directory) => {
    // arrange
    const filePath = join(directory, "sandbox.json");
    await writeFile(filePath, JSON.stringify({ network: { allowedDomains: ["a.com"] }, profiles: { bazel: {} } }));

    // act
    await updateActivationDecisions(filePath, ({ allowed }) => { allowed.add("bazel"); });
    await updateActivationDecisions(filePath, ({ allowed, denied }) => { allowed.delete("bazel"); denied.set("bazel", "no"); });

    // assert
    const decisions = await loadActivationDecisions(filePath);
    assert.deepEqual([...decisions.allowed], []);
    assert.deepEqual([...decisions.denied], [["bazel", "no"]]);
    const written = JSON.parse(await readFile(filePath, "utf8"));
    assert.deepEqual(written.network, { allowedDomains: ["a.com"] });
    assert.deepEqual(Object.keys(written.profiles), ["bazel"]);
  });
});

test("the activation key is absent from files that never had a decision", async () => {
  await withDirectory(async (directory) => {
    // arrange
    const filePath = join(directory, "sandbox.json");
    await writeFile(filePath, JSON.stringify({ profiles: { bazel: {} } }));

    // act
    await updateActivationDecisions(filePath, () => undefined);
    await updateProfile(filePath, "bazel", (current) => current);

    // assert
    const written = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal("profileActivation" in written, false);
  });
});

test("deleting a profile removes its activation decision", async () => {
  await withDirectory(async (directory) => {
    // arrange
    const filePath = join(directory, "sandbox.json");
    await writeFile(filePath, JSON.stringify({ profiles: { bazel: {} }, profileActivation: { allowed: ["bazel", "other"], denied: [] } }));

    // act
    await updateProfile(filePath, "bazel", () => undefined);

    // assert
    const decisions = await loadActivationDecisions(filePath);
    assert.deepEqual([...decisions.allowed], ["other"]);
  });
});
