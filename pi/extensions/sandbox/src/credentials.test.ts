import assert from "node:assert/strict";
import test from "node:test";
import { credentialEnvVars } from "./credentials.ts";

test("credential-looking names are masked", () => {
  // arrange
  const environment = {
    ANTHROPIC_API_KEY: "sk-1",
    GH_TOKEN: "gh-1",
    AWS_SECRET_ACCESS_KEY: "aws-1",
    AWS_ACCESS_KEY_ID: "aws-2",
    DATABASE_PASSWORD: "pw",
    MY_PRIVATE_KEY: "key",
  };

  // act
  const entries = credentialEnvVars(environment);

  // assert
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ["ANTHROPIC_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "DATABASE_PASSWORD", "GH_TOKEN", "MY_PRIVATE_KEY"],
  );
  assert.ok(entries.every((entry) => entry.mode === "mask"));
});

test("ordinary names are left alone", () => {
  // arrange
  const environment = { PATH: "/bin", HOME: "/home", EDITOR: "vim", SHELL: "/bin/sh", COLOR: "blue" };

  // act
  const entries = credentialEnvVars(environment);

  // assert
  assert.deepEqual(entries, []);
});

test("variables with an empty value are left alone", () => {
  // arrange
  const environment = { EMPTY_TOKEN: "", REAL_TOKEN: "value" };

  // act
  const entries = credentialEnvVars(environment);

  // assert
  assert.deepEqual(entries.map((entry) => entry.name), ["REAL_TOKEN"]);
});

test("entries are sorted by name", () => {
  // arrange
  const environment = { Z_TOKEN: "z", A_TOKEN: "a", M_TOKEN: "m" };

  // act
  const entries = credentialEnvVars(environment);

  // assert
  assert.deepEqual(entries.map((entry) => entry.name), ["A_TOKEN", "M_TOKEN", "Z_TOKEN"]);
});
