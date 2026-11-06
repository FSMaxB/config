// Adversarial cases for the OS-level filesystem sandbox. Every test asserts that an
// escape attempt FAILS. Run with SANDBOX_INTEGRATION=1 (CI does this natively on
// ubuntu-26.04 and macos-26 for integration.test.ts and escape.test.ts).
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createServer, type Server } from "node:net";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { tree, type PathSelector } from "../../lib/path-permission-rules.ts";
import { filesystemConfig } from "./policy.ts";
import { scanVcsLayout, vcsWriteRules } from "./vcs-policy.ts";

const enabled = process.env.SANDBOX_INTEGRATION === "1";

let root: string;
let workDirectory: string;
let fakeHome: string;
let fakeAgentExtensions: string;
let loopback: Server;
let loopbackPort: number;
let repository: string;

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
  repository = join(workDirectory, "repo");
  execFileSync("git", ["init", "--quiet", "--template=", repository]);
  await mkdir(join(repository, ".git", "info"));
  await mkdir(join(repository, ".jj", "repo", "store", "git", "hooks"), { recursive: true });
  await writeFile(join(repository, ".jj", "repo", "config-id"), "id\n");
  await writeFile(join(repository, ".jj", "repo", "store", "git_target"), "../../../.git\n");
  await writeFile(join(repository, ".jj", "repo", "store", "git", "config"), "[core]\n");
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

// Both the macOS allowlist and the Linux enumerated deny must stop a command from planting a file that a
// later git or jj run outside the sandbox would execute or trust.
test("a planted .git/commondir never reaches the real filesystem on macOS", { skip: !enabled || process.platform !== "darwin" }, async () => {
  // arrange
  const target = join(repository, ".git", "commondir");

  // act
  await runInRepository(`echo x > '${target}'`);

  // assert
  assert.equal(existsSync(target), false);
});

test("a jj config-id cannot be removed", { skip: !enabled }, async () => {
  // arrange
  const target = join(repository, ".jj", "repo", "config-id");

  // act
  await runInRepository(`rm '${target}'`);

  // assert
  assert.equal(readFileSync(target, "utf8"), "id\n");
});

test("a planted .jj/repo/config.toml never reaches the real filesystem", { skip: !enabled }, async () => {
  // arrange
  const target = join(repository, ".jj", "repo", "config.toml");

  // act
  await runInRepository(`echo x > '${target}'`);

  // assert
  assert.equal(existsSync(target), false);
});

test("the git directory behind a jj repository cannot be repointed", { skip: !enabled }, async () => {
  // arrange
  const target = join(repository, ".jj", "repo", "store", "git_target");

  // act
  await runInRepository(`echo x > '${target}'`);

  // assert
  assert.equal(readFileSync(target, "utf8"), "../../../.git\n");
});

test("a nested git directory keeps its config and hooks", { skip: !enabled }, async () => {
  // arrange
  const config = join(repository, ".jj", "repo", "store", "git", "config");
  const hook = join(repository, ".jj", "repo", "store", "git", "hooks", "pre-commit");

  // act
  await runInRepository(`echo x > '${config}'; echo x > '${hook}'`);

  // assert
  assert.equal(readFileSync(config, "utf8"), "[core]\n");
  assert.equal(existsSync(hook), false);
});

test("submodule, worktree and attribute files cannot be planted in .git", { skip: !enabled }, async () => {
  // arrange
  const modules = join(repository, ".git", "modules");
  const attributes = join(repository, ".git", "info", "attributes");

  // act
  await runInRepository(`mkdir '${modules}'; echo x > '${attributes}'`);

  // assert
  assert.equal(existsSync(modules), false);
  assert.equal(existsSync(attributes), false);
});

test("a write to an allowlisted path inside .git still works", { skip: !enabled }, async () => {
  // arrange
  const target = join(repository, ".git", "COMMIT_EDITMSG");

  // act
  const { exitCode, output } = await runInRepository(`echo x > '${target}'`);

  // assert
  assert.equal(exitCode, 0, output);
  assert.equal(readFileSync(target, "utf8"), "x\n");
});

// APFS is case-insensitive, so an upper-cased spelling reaches the real directory.
test("no spelling of .git or .jj is writable on macOS", { skip: !enabled || process.platform !== "darwin" }, async () => {
  // act
  await runInRepository(`touch '${repository}/.GIT/planted' '${repository}/.Git/planted2' '${repository}/.JJ/planted3' '${repository}/.jJ/planted4' '${repository}/.git/planted5'`);

  // assert
  for (const name of [".git/planted", ".git/planted2", ".jj/planted3", ".jj/planted4", ".git/planted5"]) {
    assert.equal(existsSync(join(repository, name)), false, name);
  }
});

test("everything outside .git and .jj stays writable, however deep", { skip: !enabled }, async () => {
  // act
  const { exitCode, output } = await runInRepository(`mkdir -p src/deep/er .github/workflows && touch src/deep/er/a.ts .github/workflows/ci.yml .gitignore .envrc top.txt && rm top.txt`);

  // assert
  assert.equal(exitCode, 0, output);
  assert.ok(existsSync(join(repository, "src", "deep", "er", "a.ts")));
  assert.ok(existsSync(join(repository, ".github", "workflows", "ci.yml")));
});

async function runInRepository(command: string): Promise<{ exitCode: number | null; output: string; commandId: string }> {
  const vcs = vcsWriteRules(await scanVcsLayout(repository), process.platform as "darwin" | "linux");
  const policy = {
    read: { allow: [tree(workDirectory)], deny: [], protected: [] },
    write: { allow: [tree(repository)], deny: [], protected: [] },
  };
  const filesystem = filesystemConfig(policy, { platform: process.platform as "darwin" | "linux", homeDirectory: fakeHome, toolchainRead: [], extraDenyRead: [], vcs });
  return await runSandboxed(command, filesystem, repository);
}

function policyFilesystem(extraReadAllow: PathSelector[] = [], protectedWrite: PathSelector[] = []) {
  const policy = {
    read: { allow: [tree(workDirectory), ...extraReadAllow], deny: [], protected: [] },
    write: { allow: [tree(workDirectory)], deny: [], protected: protectedWrite },
  };
  return filesystemConfig(policy, { platform: process.platform as "darwin" | "linux", homeDirectory: fakeHome, toolchainRead: [], extraDenyRead: [] });
}

async function runSandboxed(command: string, filesystem = policyFilesystem(), cwd = workDirectory): Promise<{ exitCode: number | null; output: string; commandId: string }> {
  const commandId = `${Date.now()}-${Math.random()}`;
  const wrapped = await SandboxManager.wrapWithSandbox(command, undefined, { filesystem }, undefined, { commandId, commandText: command });
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(wrapped, { shell: true, cwd });
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
