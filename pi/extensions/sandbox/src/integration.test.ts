import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { tree } from "../../lib/path-permission-rules.ts";
import { filesystemConfig } from "./policy.ts";

const enabled = process.env.SANDBOX_INTEGRATION === "1";

let root: string;
let workDirectory: string;
let fakeHome: string;

before(async () => {
  if (!enabled) return;
  root = await realpath(await mkdtemp(join(tmpdir(), "sandbox-integration-")));
  workDirectory = join(root, "work");
  fakeHome = join(root, "home");
  await mkdir(workDirectory);
  await mkdir(join(fakeHome, ".ssh"), { recursive: true });
  await writeFile(join(fakeHome, ".ssh", "config"), "Host secret\n");
  await SandboxManager.initialize(
    { network: { allowedDomains: [], deniedDomains: [] }, filesystem: policyFilesystem(), allowPty: false },
    async () => false,
    true,
  );
});

after(async () => {
  if (!enabled) return;
  await SandboxManager.reset();
  await rm(root, { recursive: true, force: true });
});

test("the writable directory accepts writes", { skip: !enabled }, async () => {
  // arrange
  const target = join(workDirectory, "ok");

  // act
  const { exitCode, output } = await runSandboxed(`touch '${target}'`);

  // assert
  assert.equal(exitCode, 0, output);
  assert.ok(existsSync(target));
});

// Linux masks denied trees with an empty tmpfs, so the write itself succeeds there and only the real
// filesystem shows that nothing landed; macOS refuses the write outright.
test("writes outside the writable directory never reach the real filesystem", { skip: !enabled }, async () => {
  // arrange
  const target = join(homedir(), ".sandbox-escape");

  // act
  await runSandboxed(`touch '${target}'`);

  // assert
  assert.equal(existsSync(target), false);
});

test("secrets under the home directory are unreadable", { skip: !enabled }, async () => {
  // arrange
  const target = join(fakeHome, ".ssh", "config");

  // act
  const { exitCode, output } = await runSandboxed(`cat '${target}'`);

  // assert
  assert.notEqual(exitCode, 0, output);
  assert.doesNotMatch(output, /Host secret/);
});

test("network access is denied without an allowlist entry", { skip: !enabled }, async () => {
  // act
  const { exitCode, output } = await runSandboxed("curl -sS --max-time 5 https://example.com");

  // assert
  assert.notEqual(exitCode, 0, output);
});

function policyFilesystem() {
  const policy = {
    read: { allow: [tree(workDirectory)], deny: [], protected: [] },
    write: { allow: [tree(workDirectory)], deny: [], protected: [] },
  };
  return filesystemConfig(policy, { platform: process.platform as "darwin" | "linux", homeDirectory: fakeHome, toolchainRead: [], extraDenyRead: [] });
}

async function runSandboxed(command: string): Promise<{ exitCode: number | null; output: string }> {
  const commandId = `${Date.now()}-${Math.random()}`;
  const wrapped = await SandboxManager.wrapWithSandbox(command, undefined, { filesystem: policyFilesystem() }, undefined, { commandId, commandText: command });
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(wrapped, { shell: true, cwd: workDirectory });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      child.on("error", reject);
      child.on("close", (exitCode) => resolve({ exitCode, output }));
    });
  } finally {
    SandboxManager.cleanupAfterCommand();
  }
}
