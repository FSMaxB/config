import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execChecked } from "./exec.ts";

function fakePi({ truncated } = { truncated: false }): ExtensionAPI {
  return { exec: async () => ({ stdout: "", stderr: "", code: 1, killed: true, truncated }) } as unknown as ExtensionAPI;
}

test("an aborted invocation reports an abort instead of a timeout", async () => {
  // arrange
  const controller = new AbortController();
  controller.abort();

  // act & assert
  await assert.rejects(execChecked(fakePi(), "crit", ["review"], { signal: controller.signal, timeout: 15000 }), /was aborted\./);
});

test("a killed invocation reports the timeout", async () => {
  // arrange
  const pi = fakePi();

  // act & assert
  await assert.rejects(execChecked(pi, "crit", ["review"], { timeout: 15000 }), /timed out after 15s\./);
});

test("an invocation killed for too much output reports that instead of a timeout", async () => {
  // arrange
  const pi = fakePi({ truncated: true });

  // act & assert
  await assert.rejects(execChecked(pi, "crit", ["review"], { timeout: 15000 }), /output exceeded pi\.exec's buffer limit\./);
});
