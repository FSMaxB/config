import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { effectiveNetwork, emptyGrants, parseGrants, recordGrant, serializeGrants } from "./network-grants.ts";
import { loadSettings, parseSettingsFile, resolveSettings, updateDomainLists } from "./settings.ts";

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
  recordGrant(grants, "deny", "stored-allow.com");
  recordGrant(grants, "allow", "stored-deny.com");
  recordGrant(grants, "allow", "new.com");

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
  recordGrant(grants, "allow", "a.com");
  recordGrant(grants, "deny", "b.com");

  // act
  const restored = parseGrants(serializeGrants(grants));
  const fromGarbage = parseGrants("nonsense");

  // assert
  assert.deepEqual([...restored.allow], ["a.com"]);
  assert.deepEqual([...restored.deny], ["b.com"]);
  assert.equal(fromGarbage.allow.size, 0);
});

test("a later decision for the same host replaces the earlier one", () => {
  // arrange
  const grants = emptyGrants();
  recordGrant(grants, "allow", "a.com");

  // act
  recordGrant(grants, "deny", "a.com");

  // assert
  assert.equal(grants.allow.has("a.com"), false);
  assert.equal(grants.deny.has("a.com"), true);
});
