import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { jjShimDirectory, withJjShim } from "./jj-shim.ts";

const FAKE_JJ = "#!/bin/sh\nprintf '%s\\n' \"$@\"\n";
const SHIM_TIMEOUT_MILLISECONDS = 5000;

let directory: string;
let fakeDirectory: string;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "jj-shim-"));
  fakeDirectory = join(directory, "fake");
  await mkdir(fakeDirectory);
  await writeFile(join(fakeDirectory, "jj"), FAKE_JJ);
  await chmod(join(fakeDirectory, "jj"), 0o755);
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("withJjShim puts the shim directory first on PATH and keeps other variables", () => {
  // arrange
  const environment = { PATH: "/usr/bin", HOME: "/home/test" };
  const expected = { PATH: `${jjShimDirectory()}:/usr/bin`, HOME: "/home/test" };

  // act
  const result = withJjShim(environment);

  // assert
  assert.deepEqual(result, expected);
});

test("the shim runs the next jj on PATH with watchman turned off", () => {
  // arrange
  const path = [jjShimDirectory(), fakeDirectory, "/usr/bin", "/bin"].join(":");
  const expectedLines = ["--config", "fsmonitor.backend=none", "log", "-r", "@ x"];

  // act
  const result = runShim(path, ["log", "-r", "@ x"]);

  // assert
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trimEnd().split("\n"), expectedLines);
});

test("the shim skips its own directory reached through a symlink", async () => {
  // arrange
  const link = join(directory, "link");
  await symlink(jjShimDirectory(), link);
  const path = [link, fakeDirectory, "/usr/bin", "/bin"].join(":");
  const expectedLines = ["--config", "fsmonitor.backend=none", "log", "-r", "@ x"];

  // act
  const result = runShim(path, ["log", "-r", "@ x"]);

  // assert
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trimEnd().split("\n"), expectedLines);
});

test("without another jj on PATH the shim fails", () => {
  // arrange
  const path = [jjShimDirectory(), "/usr/bin", "/bin"].join(":");
  const expectedStatus = 127;

  // act
  const result = runShim(path, ["status"]);

  // assert
  assert.equal(result.status, expectedStatus);
  assert.match(result.stderr, /no jj on PATH/);
});

function runShim(path: string, shimArguments: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(join(jjShimDirectory(), "jj"), shimArguments, { env: { PATH: path }, encoding: "utf8", timeout: SHIM_TIMEOUT_MILLISECONDS });
}
