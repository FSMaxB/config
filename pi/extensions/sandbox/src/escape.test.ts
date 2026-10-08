// Adversarial cases for the OS-level filesystem sandbox. Every test asserts that an
// escape attempt FAILS. Run with SANDBOX_INTEGRATION=1 (CI does this natively on
// ubuntu-26.04 and macos-26 for integration.test.ts and escape.test.ts).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createServer, type Server } from "node:net";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { tree, type PathSelector } from "../../lib/path-permission-rules.ts";
import { filesystemConfig } from "./policy.ts";

const enabled = process.env.SANDBOX_INTEGRATION === "1";

let root: string;
let workDirectory: string;
let fakeHome: string;
let fakeAgentExtensions: string;
let loopback: Server;
let loopbackPort: number;

before(async () => {
  if (!enabled) return;
  root = await realpath(await mkdtemp(join(tmpdir(), "sandbox-escape-")));
  workDirectory = join(root, "work");
  fakeHome = join(root, "home");
  fakeAgentExtensions = join(fakeHome, ".pi", "agent", "extensions");
  await mkdir(workDirectory);
  await mkdir(join(fakeHome, ".ssh"), { recursive: true });
  await mkdir(fakeAgentExtensions, { recursive: true });
  await writeFile(join(fakeHome, ".ssh", "id_test"), "secret key material\n");
  await writeFile(join(fakeAgentExtensions, "existing.ts"), "// extension\n");
  loopback = createServer((socket) => socket.end("reachable\n"));
  await new Promise<void>((resolve) => loopback.listen(0, "127.0.0.1", resolve));
  loopbackPort = (loopback.address() as { port: number }).port;
  await SandboxManager.initialize(
    { network: { allowedDomains: [], deniedDomains: [] }, filesystem: policyFilesystem(), allowPty: false },
    async () => false,
    true,
  );
});

after(async () => {
  if (!enabled) return;
  await SandboxManager.reset();
  loopback.close();
  await rm(root, { recursive: true, force: true });
});

test("a symlink in the writable tree does not expose a read-denied target", { skip: !enabled }, async () => {
  // arrange
  await symlink(join(fakeHome, ".ssh", "id_test"), join(workDirectory, "link"));

  // act
  const { exitCode, output } = await runSandboxed(`cat '${join(workDirectory, "link")}'`);

  // assert
  assert.notEqual(exitCode, 0, output);
  assert.doesNotMatch(output, /secret key material/);
});

test("a hardlink to a secret cannot be created from inside the sandbox", { skip: !enabled }, async () => {
  // arrange
  const link = join(workDirectory, "hard");

  // act
  const { exitCode, output } = await runSandboxed(`ln '${join(fakeHome, ".ssh", "id_test")}' '${link}' && cat '${link}'`);

  // assert
  assert.notEqual(exitCode, 0, output);
  assert.doesNotMatch(output, /secret key material/);
});

test("dot-dot traversal out of the writable tree is denied", { skip: !enabled }, async () => {
  // act
  const { exitCode, output } = await runSandboxed(`cat '${workDirectory}/../home/.ssh/id_test'`);

  // assert
  assert.notEqual(exitCode, 0, output);
  assert.doesNotMatch(output, /secret key material/);
});

test("a write to a protected agent path never reaches the real filesystem", { skip: !enabled }, async () => {
  // arrange
  const target = join(fakeAgentExtensions, "new.ts");
  const filesystem = policyFilesystem([], [tree(fakeAgentExtensions)]);

  // act
  await runSandboxed(`touch '${target}'`, filesystem);

  // assert
  assert.equal(existsSync(target), false);
});

test("the sandbox refuses connections to a listening loopback server", { skip: !enabled }, async () => {
  // act
  const { exitCode, output } = await runSandboxed(`curl -sS --max-time 5 'http://127.0.0.1:${loopbackPort}/'`);

  // assert
  assert.notEqual(exitCode, 0, output);
  assert.doesNotMatch(output, /reachable/);
});

test("outbound UDP to an arbitrary resolver is refused", { skip: !enabled }, async () => {
  // act: a raw UDP socket to 8.8.8.8:53 must be blocked by the socket rules. The
  // marker proves node actually ran inside the sandbox, so a missing node cannot
  // pass the test vacuously. macOS refuses the implicit bind, which reaches the
  // 'error' event; Linux has no route in the isolated network namespace, and a
  // failed send is reported to the send callback instead.
  const { exitCode, output } = await runSandboxed(
    `node -e "console.log('node-ran');const d=require('dgram');const s=d.createSocket('udp4');` +
      `s.on('error',()=>process.exit(1));` +
      `s.send('probe',53,'8.8.8.8',(error)=>{console.log(error?'blocked '+error.code:'sent');process.exit(error?1:0)});` +
      `setTimeout(()=>process.exit(2),3000)"`,
  );

  // assert
  assert.match(output, /node-ran/);
  assert.notEqual(exitCode, 0, output);
  assert.doesNotMatch(output, /sent/);
});

// On Linux the socket rules also block getaddrinfo's resolver traffic. On macOS the
// system resolver (mDNSResponder) may answer lookups initiated inside the sandbox —
// that is a documented limitation of socket-based filtering, so this asserts on
// Linux only and macOS is checked manually (see Verification step 4e).
test("DNS resolution fails inside the sandbox", { skip: !enabled || process.platform === "darwin" }, async () => {
  // act
  const { exitCode, output } = await runSandboxed(
    `node -e "console.log('node-ran');require('dns').lookup('example.com',(error,address)=>{` +
      `console.log(error?'blocked':'resolved '+address);process.exit(error?1:0)})"`,
  );

  // assert
  assert.match(output, /node-ran/);
  assert.notEqual(exitCode, 0, output);
  assert.match(output, /blocked/);
});

function policyFilesystem(extraReadAllow: PathSelector[] = [], protectedWrite: PathSelector[] = []) {
  const policy = {
    read: { allow: [tree(workDirectory), ...extraReadAllow], deny: [], protected: [] },
    write: { allow: [tree(workDirectory)], deny: [], protected: protectedWrite },
  };
  return filesystemConfig(policy, { platform: process.platform as "darwin" | "linux", homeDirectory: fakeHome, toolchainRead: [], extraDenyRead: [] });
}

async function runSandboxed(command: string, filesystem = policyFilesystem()): Promise<{ exitCode: number | null; output: string; commandId: string }> {
  const commandId = `${Date.now()}-${Math.random()}`;
  const wrapped = await SandboxManager.wrapWithSandbox(command, undefined, { filesystem }, undefined, { commandId, commandText: command });
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(wrapped, { shell: true, cwd: workDirectory });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      child.on("error", reject);
      child.on("close", (exitCode) => resolve({ exitCode, output, commandId }));
    });
  } finally {
    SandboxManager.cleanupAfterCommand();
  }
}
