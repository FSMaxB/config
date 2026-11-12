import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { exact, glob, tree, type PathSelector } from "../../lib/path-permission-rules.ts";
import { filesystemConfig } from "./policy.ts";
import { mktempShimDirectory } from "./scratch.ts";
import { scanVcsLayout, vcsWriteRules } from "./vcs-policy.ts";
import { startViolationCollector, type ViolationCollector } from "./violation-collector.ts";
import { discardedWrites, isRepositoryRootRemoval, pathViolations } from "./violations.ts";

const enabled = process.env.SANDBOX_INTEGRATION === "1";

let root: string;
let workDirectory: string;
let fakeHome: string;
let collector: ViolationCollector;

before(async () => {
  if (!enabled) return;
  root = await realpath(await mkdtemp(join(tmpdir(), "sandbox-integration-")));
  workDirectory = join(root, "work");
  fakeHome = join(root, "home");
  await mkdir(workDirectory);
  await mkdir(join(root, "vcs-home", ".config"), { recursive: true });
  await mkdir(join(fakeHome, ".ssh"), { recursive: true });
  await writeFile(join(fakeHome, ".ssh", "config"), "Host secret\n");
  await writeFile(join(fakeHome, ".netrc"), "machine secret\n");
  await writeFile(join(fakeHome, "notes.txt"), "visible notes\n");
  await SandboxManager.initialize(
    { network: { allowedDomains: [], deniedDomains: [] }, filesystem: policyFilesystem(), allowPty: false },
    async () => false,
    true,
  );
  collector = startViolationCollector(process.platform as "darwin" | "linux", SandboxManager.getSandboxViolationStore());
});

after(async () => {
  if (!enabled) return;
  collector.stop();
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

test("a grant of the secret directory itself does not expose it", { skip: !enabled }, async () => {
  // arrange
  const filesystem = policyFilesystem([exact(join(fakeHome, ".ssh"))]);

  // act
  const { exitCode, output } = await runSandboxed(`cat '${join(fakeHome, ".ssh", "config")}'`, filesystem);

  // assert
  assert.notEqual(exitCode, 0, output);
  assert.doesNotMatch(output, /Host secret/);
});

test("a glob grant above a secret does not expose it", { skip: !enabled }, async () => {
  // arrange
  const filesystem = policyFilesystem([glob(fakeHome, "*"), glob(fakeHome, ".*")]);

  // act
  const netrc = await runSandboxed(`cat '${join(fakeHome, ".netrc")}'`, filesystem);
  const sshConfig = await runSandboxed(`cat '${join(fakeHome, ".ssh", "config")}'`, filesystem);

  // assert
  assert.notEqual(netrc.exitCode, 0, netrc.output);
  assert.doesNotMatch(netrc.output, /machine secret/);
  assert.notEqual(sshConfig.exitCode, 0, sshConfig.output);
  assert.doesNotMatch(sshConfig.output, /Host secret/);
});

test("a glob grant that cannot reach a secret still works", { skip: !enabled }, async () => {
  // arrange
  const filesystem = policyFilesystem([glob(fakeHome, "*.txt")]);

  // act
  const { exitCode, output } = await runSandboxed(`cat '${join(fakeHome, "notes.txt")}'`, filesystem);

  // assert
  assert.equal(exitCode, 0, output);
  assert.match(output, /visible notes/);
});

// Linux masks the read-denied home directory with a writable tmpfs, so the write exits 0 and vanishes; the
// violation monitor still records it, which is what the discarded-writes report in extension.ts reads.
test("Linux reports a write that the read-deny tmpfs discarded", { skip: !enabled || process.platform !== "linux" }, async () => {
  // arrange
  const target = join(fakeHome, "discarded");

  // act
  const { exitCode, commandId } = await runSandboxed(`touch '${target}'`);

  // assert
  assert.equal(exitCode, 0);
  let violations = collector.violationsFor(commandId);
  for (let poll = 0; poll < 6 && violations.length === 0; poll += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    violations = collector.violationsFor(commandId);
  }
  const discarded = discardedWrites(pathViolations(violations.map(({ line }) => line)), policyFilesystem(), "linux");
  assert.ok(discarded.some((violation) => violation.mode === "write" && violation.path === target), `the monitor must record the tmpfs write: ${JSON.stringify(discarded)}`);
});

// srt 0.0.77's Linux observer only reports write-intent syscalls and read-denied trees are masked with
// a tmpfs, so a denied read fails with ENOENT and leaves no record there; macOS seatbelt logs the deny.
test("a denied read is recorded on macOS but masked silently on Linux", { skip: !enabled }, async () => {
  // arrange
  const target = join(fakeHome, "notes.txt");

  // act
  const { commandId } = await runSandboxed(`cat '${target}'`);
  const violations = pathViolations((await collectViolations(commandId)).map(({ line }) => line));

  // assert
  if (process.platform === "darwin") {
    assert.ok(violations.some((violation) => violation.mode === "read" && violation.path === target), `expected a read violation for ${target}: ${JSON.stringify(violations)}`);
  } else {
    assert.deepEqual(violations, []);
  }
});

// srt's own monitor keeps one violation per `log stream` chunk, which is what the collector replaces.
test("a burst of denied writes is reported in full on macOS", { skip: !enabled || process.platform !== "darwin" }, async () => {
  // arrange
  const command = `for i in $(seq 1 30); do : > '${fakeHome}/burst-'$i; done; true`;

  // act
  const { exitCode, commandId } = await runSandboxed(command);
  const violations = pathViolations((await collectViolations(commandId)).map(({ line }) => line));

  // assert
  assert.equal(exitCode, 0);
  const paths = new Set(violations.filter(({ mode }) => mode === "write").map(({ path }) => path));
  assert.equal(paths.size, 30, JSON.stringify([...paths]));
  assert.ok([...paths].every((path) => path.startsWith(`${fakeHome}/burst-`)));
});

test("an exit-0 command can still carry violations on macOS", { skip: !enabled || process.platform !== "darwin" }, async () => {
  // arrange
  const target = join(fakeHome, "notes.txt");

  // act
  const { exitCode, commandId } = await runSandboxed(`cat '${target}' 2>/dev/null || true`);
  const violations = pathViolations((await collectViolations(commandId)).map(({ line }) => line));

  // assert
  assert.equal(exitCode, 0);
  assert.ok(violations.some((violation) => violation.mode === "read" && violation.path === target), `expected a read violation for ${target}: ${JSON.stringify(violations)}`);
});

const jjAvailable = spawnSync("jj", ["--version"]).error === undefined;
const gitLfsAvailable = spawnSync("git", ["lfs", "version"]).status === 0;

const GIT_BATTERY = [
  "set -e",
  "echo a > a.txt && git add a.txt && git commit -q -m one",
  "git checkout -q -b feature",
  "echo b > b.txt && git add b.txt && git commit -q -m two",
  "git checkout -q main",
  "git merge -q --no-edit feature",
  "git reset -q --hard HEAD~1",
  "echo c > c.txt && git add c.txt && git commit -q -m three",
  "git rebase -q feature",
  "git tag -a v1 -m v1",
  "git gc -q",
  "git log --oneline > /dev/null && git status --short > /dev/null && git diff > /dev/null",
].join("\n");

const JJ_BATTERY = [
  "set -e",
  "jj new && jj describe -m x",
  "echo f > f.txt && jj commit -m y",
  "jj bookmark create b -r @-",
  "jj rebase -r @ -d b",
  "jj abandon @ && jj undo",
  "jj git export",
  "jj log > /dev/null && jj status > /dev/null && jj diff > /dev/null",
  "git log --oneline > /dev/null && git status --short > /dev/null",
].join("\n");

// git stash unlinks its temporary index through remove_path(), which then tries to rmdir the emptied parent:
// .git itself. The sandbox denies that, and git ignores the failure.
test("git stash works and only reports git's attempt to remove .git", { skip: !enabled }, async () => {
  // arrange
  const repository = join(workDirectory, "stash-repo");
  execFileSync("git", ["init", "--quiet", "--template=", "-b", "main", repository]);
  await mkdir(join(repository, ".git", "info"));
  await writeFile(join(repository, ".git", "info", "exclude"), "");
  const script = "set -e\necho a > a.txt && git add a.txt && git commit -q -m one\necho b >> a.txt && git stash -q && git stash pop -q";

  // act
  const { exitCode, output, commandId } = await runInRepository(repository, `${vcsEnvironment()}\n${script}`);

  // assert
  assert.equal(exitCode, 0, output);
  const violations = pathViolations((await collectViolations(commandId)).map(({ line }) => line));
  assert.deepEqual(violations.filter((violation) => violation.path !== join(repository, ".git")), []);
});

test("a git session works inside the sandbox without violations", { skip: !enabled }, async () => {
  // arrange
  const repository = join(workDirectory, "git-repo");
  execFileSync("git", ["init", "--quiet", "--template=", "-b", "main", repository]);
  await mkdir(join(repository, ".git", "info"));
  await writeFile(join(repository, ".git", "info", "exclude"), "");

  // act
  const { exitCode, output, commandId } = await runInRepository(repository, `${vcsEnvironment()}\n${GIT_BATTERY}`);

  // assert
  assert.equal(exitCode, 0, output);
  assert.deepEqual(pathViolations((await collectViolations(commandId)).map(({ line }) => line)), []);
});

test("mktemp creates its files in TMPDIR through the shim", { skip: !enabled || process.platform !== "darwin" }, async () => {
  // arrange
  const command = `export TMPDIR='${workDirectory}' PATH='${mktempShimDirectory()}':"$PATH"; mktemp; mktemp -d; mktemp -t prefix; mktemp '${workDirectory}/named.XXXXXX'`;

  // act
  const { exitCode, output, commandId } = await runSandboxed(command);

  // assert
  assert.equal(exitCode, 0, output);
  const created = output.trim().split("\n");
  assert.equal(created.length, 4, output);
  for (const path of created) assert.ok(path.startsWith(`${workDirectory}/`), path);
  assert.deepEqual(pathViolations((await collectViolations(commandId)).map(({ line }) => line)), []);
});

// jj git init itself runs outside the sandbox: it creates files in .jj that the allowlist leaves to the user.
test("a jj session works inside the sandbox without violations", { skip: !enabled || !jjAvailable }, async () => {
  // arrange
  const repository = join(workDirectory, "jj-repo");
  await mkdir(repository);
  execFileSync("jj", ["git", "init", "--colocate", repository], { env: { ...process.env, ...vcsEnvironmentVariables() }, stdio: "pipe" });

  // act
  const { exitCode, output, commandId } = await runInRepository(repository, `${vcsEnvironment()}\n${JJ_BATTERY}`);

  // assert
  assert.equal(exitCode, 0, output);
  assert.deepEqual(pathViolations((await collectViolations(commandId)).map(({ line }) => line)), []);
});

// On Linux the repository root stays writable and the rmdir just fails with ENOTEMPTY, so only macOS reports it. jj tries
// the unlink on every checkout (the unified log shows it every time), but srt's log observer only captures it about half
// of the time, so the test cannot require the line; it requires that nothing else is reported.
test("a jj checkout that deletes a top-level file only reports the unlink of the repository root", { skip: !enabled || !jjAvailable }, async () => {
  // arrange
  const repository = join(workDirectory, "jj-checkout-repo");
  await mkdir(repository);
  execFileSync("jj", ["git", "init", "--colocate", repository], { env: { ...process.env, ...vcsEnvironmentVariables() }, stdio: "pipe" });
  const script = "set -e\necho f > f.txt && jj commit -m add\njj new 'root()'";

  // act
  const { exitCode, output, commandId } = await runInRepository(repository, `${vcsEnvironment()}\n${script}`);

  // assert
  assert.equal(exitCode, 0, output);
  const lines = (await collectViolations(commandId)).map(({ line }) => line);
  assert.deepEqual(pathViolations(lines.filter((line) => !isRepositoryRootRemoval(line, repository))), []);
});

// git lfs install runs outside the sandbox: it writes .git/hooks and .git/config, which stay denied.
test("git-lfs stores and checks out objects inside the sandbox without violations", { skip: !enabled || !gitLfsAvailable }, async () => {
  // arrange
  const repository = join(workDirectory, "lfs-repo");
  execFileSync("git", ["init", "--quiet", "--template=", "-b", "main", repository]);
  await mkdir(join(repository, ".git", "info"));
  await writeFile(join(repository, ".git", "info", "exclude"), "");
  execFileSync("git", ["lfs", "install", "--local"], { cwd: repository, env: { ...process.env, ...vcsEnvironmentVariables() }, stdio: "pipe" });
  const script = [
    "set -e",
    "git lfs track '*.bin' > /dev/null",
    "head -c 1024 /dev/urandom > blob.bin",
    "git add .gitattributes blob.bin && git commit -q -m lfs",
    "rm blob.bin && git lfs checkout blob.bin",
    "test -s blob.bin",
  ].join("\n");

  // act
  const { exitCode, output, commandId } = await runInRepository(repository, `${vcsEnvironment()}\n${script}`);

  // assert
  assert.equal(exitCode, 0, output);
  assert.deepEqual(pathViolations((await collectViolations(commandId)).map(({ line }) => line)), []);
});

test("the process exits once the sandbox is reset", { skip: !enabled }, async () => {
  // arrange
  const fixture = runTeardownFixture("reset");

  // act
  const outcome = await fixture.outcome;

  // assert
  assert.deepEqual(outcome, { kind: "exited", code: 0 });
});

test("an initialized sandbox keeps the process alive", { skip: !enabled }, async () => {
  // arrange
  const fixture = runTeardownFixture("keep");

  // act
  const outcome = await fixture.outcome;

  // assert
  assert.deepEqual(outcome, { kind: "alive" });
});

function vcsEnvironmentVariables(): Record<string, string> {
  return {
    HOME: join(root, "vcs-home"),
    XDG_CONFIG_HOME: join(root, "vcs-home", ".config"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_EDITOR: "true",
    JJ_USER: "Test",
    JJ_EMAIL: "test@example.com",
  };
}

function vcsEnvironment(): string {
  return Object.entries(vcsEnvironmentVariables()).map(([name, value]) => `export ${name}='${value}'`).join("\n");
}

async function runInRepository(repository: string, command: string) {
  const vcs = vcsWriteRules(await scanVcsLayout(repository), process.platform as "darwin" | "linux");
  const policy = {
    read: { allow: [tree(workDirectory)], deny: [], protected: [] },
    write: { allow: [tree(repository)], deny: [], protected: [] },
  };
  const filesystem = filesystemConfig(policy, { platform: process.platform as "darwin" | "linux", homeDirectory: fakeHome, toolchainRead: [], extraDenyRead: [], vcs });
  return await runSandboxed(command, filesystem, repository);
}

async function collectViolations(commandId: string) {
  let previousCount = -1;
  let violations = collector.violationsFor(commandId);
  for (let poll = 0; poll < 6; poll += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    violations = collector.violationsFor(commandId);
    if (violations.length === previousCount) break;
    previousCount = violations.length;
  }
  return violations;
}

function policyFilesystem(extraReadAllow: PathSelector[] = []) {
  const policy = {
    read: { allow: [tree(workDirectory), ...extraReadAllow], deny: [], protected: [] },
    write: { allow: [tree(workDirectory)], deny: [], protected: [] },
  };
  return filesystemConfig(policy, { platform: process.platform as "darwin" | "linux", homeDirectory: fakeHome, toolchainRead: [], extraDenyRead: [] });
}

async function runSandboxed(command: string, filesystem = policyFilesystem(), cwd = workDirectory): Promise<{ exitCode: number | null; output: string; commandId: string }> {
  const commandId = `${Date.now()}-${Math.random()}`;
  collector.track(commandId);
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

// Long enough for initialize() and reset() on a slow CI runner, short enough to keep the suite fast.
const TEARDOWN_EXIT_TIMEOUT_MILLISECONDS = 15_000;

type TeardownOutcome = { kind: "exited"; code: number | null } | { kind: "alive" };

function runTeardownFixture(teardown: "reset" | "keep"): { outcome: Promise<TeardownOutcome> } {
  const fixture = fileURLToPath(new URL("./teardown-fixture.ts", import.meta.url));
  const child = spawn(process.execPath, [fixture, teardown], { stdio: "inherit" });
  const outcome = new Promise<TeardownOutcome>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ kind: "alive" });
    }, TEARDOWN_EXIT_TIMEOUT_MILLISECONDS);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ kind: "exited", code });
    });
  });
  return { outcome };
}
