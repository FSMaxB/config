import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sessionTemporaryDirectory, TEMPORARY_DIRECTORY_ENV } from "./session-temporary-directory.ts";

test("the session temporary directory lives under the system temp dir", () => {
  // arrange
  const sessionId = "abc123ef";

  // act
  const directory = sessionTemporaryDirectory(sessionId, {});

  // assert
  assert.equal(directory, join(tmpdir(), "pi-sessions", "abc123ef"));
});

test("unsafe characters in the session id are replaced", () => {
  // arrange
  const sessionId = "../evil id";

  // act
  const directory = sessionTemporaryDirectory(sessionId, {});

  // assert
  assert.equal(directory, join(tmpdir(), "pi-sessions", ".._evil_id"));
});

test("an inherited directory from the environment wins over the session id", () => {
  // arrange
  const environment = { [TEMPORARY_DIRECTORY_ENV]: "/scratch/parent" };

  // act
  const directory = sessionTemporaryDirectory("child", environment);

  // assert
  assert.equal(directory, "/scratch/parent");
});
