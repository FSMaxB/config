import assert from "node:assert/strict";
import { accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BashSpawnContext } from "@earendil-works/pi-coding-agent";
import { exportSessionScratch, mktempShimDirectory, withSessionScratch } from "./scratch.ts";

const SESSION_ID = "01a1cfbf-1586-7514-9c42-4b6b53c37159";
const SESSION_DIRECTORY = join(tmpdir(), "pi", "4b6b53c37159");

function spawnContext(env: NodeJS.ProcessEnv): BashSpawnContext {
  return { command: "ls", cwd: "/repo", env };
}

test("on macOS bash gets the session directory as TMPDIR and the mktemp shim first on PATH", () => {
  // arrange
  const context = spawnContext({ PI_SESSION_ID: SESSION_ID, PATH: "/usr/bin" });

  // act
  const result = withSessionScratch(context, "darwin");

  // assert
  assert.equal(result.env.TMPDIR, SESSION_DIRECTORY);
  assert.equal(result.env.PATH, `${mktempShimDirectory()}:/usr/bin`);
});

test("on Linux bash gets TMPDIR and keeps PATH", () => {
  // arrange
  const context = spawnContext({ PI_SESSION_ID: SESSION_ID, PATH: "/usr/bin" });

  // act
  const result = withSessionScratch(context, "linux");

  // assert
  assert.equal(result.env.TMPDIR, SESSION_DIRECTORY);
  assert.equal(result.env.PATH, "/usr/bin");
});

test("without a session id the spawn context is unchanged", () => {
  // arrange
  const context = spawnContext({ PATH: "/usr/bin" });

  // act
  const result = withSessionScratch(context, "darwin");

  // assert
  assert.equal(result, context);
});

test("a directory inherited from the parent session wins over the session id", () => {
  // arrange
  const context = spawnContext({ PI_SESSION_ID: SESSION_ID, PI_SESSION_TEMP_DIR: "/scratch/parent" });

  // act
  const result = withSessionScratch(context, "linux");

  // assert
  assert.equal(result.env.TMPDIR, "/scratch/parent");
});

test("the command is prefixed with a one-line TMPDIR export", () => {
  // arrange
  const environment = { PI_SESSION_ID: SESSION_ID };

  // act
  const command = exportSessionScratch("ls", environment);

  // assert
  assert.equal(command, `export TMPDIR='${SESSION_DIRECTORY}'; ls`);
});

test("the command is unchanged without a session id", () => {
  // arrange
  const environment = {};

  // act
  const command = exportSessionScratch("ls", environment);

  // assert
  assert.equal(command, "ls");
});

test("the mktemp shim directory contains an executable mktemp", () => {
  // arrange
  const directory = mktempShimDirectory();

  // act
  const check = () => accessSync(join(directory, "mktemp"), constants.X_OK);

  // assert
  assert.doesNotThrow(check);
});
