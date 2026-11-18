import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadProfiles, updateProfile } from "./profile-files.ts";
import { emptyProfileDefinition } from "./profiles.ts";

test("a missing directory yields no profiles", async () => {
  await withDirectory(async (directory) => {
    // arrange
    const absent = join(directory, "absent");

    // act
    const profiles = await loadProfiles(absent);

    // assert
    assert.deepEqual(profiles, []);
  });
});

test("profiles load sorted by name and other entries are skipped", async () => {
  await withDirectory(async (directory) => {
    // arrange
    await writeFile(join(directory, "zeta.json"), "{}");
    await writeFile(join(directory, "alpha.json"), "{}");
    await writeFile(join(directory, "notes.txt"), "not a profile");
    await writeFile(join(directory, ".alpha.json.123.tmp"), "not a profile");
    await mkdir(join(directory, "alpha.json.lock"));
    const expectedAlpha = { name: "alpha", ...emptyProfileDefinition() };

    // act
    const profiles = await loadProfiles(directory);

    // assert
    assert.deepEqual(profiles.map(({ name }) => name), ["alpha", "zeta"]);
    assert.deepEqual(profiles.at(0), expectedAlpha);
  });
});

test("an invalid profile file fails the load with its path and field", async () => {
  await withDirectory(async (directory) => {
    // arrange
    const filePath = join(directory, "bazel.json");
    await writeFile(filePath, JSON.stringify({ path: ["relative"] }));

    // act
    const load = () => loadProfiles(directory);

    // assert
    await assert.rejects(load, (error: unknown) => error instanceof Error && error.message.includes(filePath) && error.message.includes("path[0] must start with"));
  });
});

test("a file name that is not a profile name fails the load", async () => {
  await withDirectory(async (directory) => {
    // arrange
    await writeFile(join(directory, "Bad_Name.json"), "{}");

    // act
    const load = () => loadProfiles(directory);

    // assert
    await assert.rejects(load, /Invalid sandbox profile file name/);
  });
});

test("updating a profile creates, changes and deletes its file", async () => {
  await withDirectory(async (directory) => {
    // arrange
    const filePath = join(directory, "bazel.json");

    // act
    await updateProfile(directory, "bazel", () => emptyProfileDefinition());
    await updateProfile(directory, "bazel", (current) => current && { ...current, path: ["/bin"] });
    const changed = await loadProfiles(directory);
    await updateProfile(directory, "bazel", () => undefined);

    // assert
    assert.deepEqual(changed.map(({ name, path }) => ({ name, path })), [{ name: "bazel", path: ["/bin"] }]);
    await assert.rejects(stat(filePath), { code: "ENOENT" });
  });
});

test("an invalid name is rejected before anything is written", async () => {
  await withDirectory(async (directory) => {
    // arrange
    const profilesDirectory = join(directory, "profiles");

    // act
    const update = () => updateProfile(profilesDirectory, "../escape", () => emptyProfileDefinition());

    // assert
    await assert.rejects(update, /Invalid sandbox profile file name/);
    assert.ok(!(await readdir(dirname(profilesDirectory))).includes("escape.json"));
  });
});

async function withDirectory<T>(body: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "sandbox-profiles-"));
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
