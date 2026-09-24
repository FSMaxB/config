import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  commitInvocations,
  commitMessage,
  commitPlanFile,
  initInvocation,
  isUnchanged,
  statusInvocation,
  type Executor,
} from "./plan-commit.ts";

// A fixed identity keeps the git commits below independent of the machine's git config
// (CI runners have none). jj reads its own config and only warns when it is missing.
const identity = {
  GIT_AUTHOR_NAME: "plan-commit test",
  GIT_AUTHOR_EMAIL: "plan-commit@test.invalid",
  GIT_COMMITTER_NAME: "plan-commit test",
  GIT_COMMITTER_EMAIL: "plan-commit@test.invalid",
};

const realExecutor: Executor = (command, args, cwd) =>
  new Promise((resolve) => {
    execFile(command, args, { cwd, env: { ...process.env, ...identity } }, (error, stdout, stderr) => {
      const code = error && typeof (error as NodeJS.ErrnoException).code === "number"
        ? (error as { code: number }).code
        : error ? 127 : 0;
      resolve({ stdout, stderr, code });
    });
  });

// Pretends jj is not installed so the git fallback can be exercised on a machine that has jj.
const withoutJj: Executor = (command, args, cwd) =>
  command === "jj"
    ? Promise.resolve({ stdout: "", stderr: "jj: command not found", code: 127 })
    : realExecutor(command, args, cwd);

test("initInvocation prefers a colocated jj repository", () => {
  // arrange / act
  const invocation = initInvocation("jj");

  // assert
  assert.deepEqual(invocation, { command: "jj", args: ["git", "init", "--colocate"] });
});

test("commitInvocations for git stages and commits only the plan file", () => {
  // arrange
  const path = "20260916-1628-plan.md";

  // act
  const invocations = commitInvocations("git", "/plans", path, "Submit plan: x");

  // assert
  assert.deepEqual(invocations.map((invocation) => invocation.args.slice(-2)), [["--", path], ["--", path]]);
});

test("commitMessage names the reason and strips the extension", () => {
  // arrange / act / assert
  assert.equal(commitMessage("/plans/20260916-1628-plan.md", "submit"), "Submit plan: 20260916-1628-plan");
  assert.equal(commitMessage("/plans/20260916-1628-plan.md", "review"), "Review plan: 20260916-1628-plan");
});

test("isUnchanged treats whitespace-only status as clean", () => {
  // arrange / act / assert
  assert.equal(isUnchanged("\n"), true);
  assert.equal(isUnchanged("M plan.md\n"), false);
});

test("a fresh directory becomes a jj repository holding only the submitted plan", { skip: !(await hasBinary("jj")) }, async () => {
  // arrange
  const directory = await mkdtemp(join(tmpdir(), "plan-commit-"));
  const planFile = join(directory, "20260916-1628-plan.md");
  await writeFile(planFile, "# Plan\n");
  await writeFile(join(directory, "other.md"), "# Other\n");

  // act
  const outcome = await commitPlanFile(realExecutor, planFile, "submit");

  // assert
  assert.deepEqual(outcome, { kind: "committed", vcs: "jj" });
  const committed = await realExecutor("jj", ["-R", directory, "--no-pager", "diff", "-r", "@-", "--summary"], directory);
  assert.equal(committed.stdout.trim(), "A 20260916-1628-plan.md");
  const workingCopy = await realExecutor("jj", ["-R", directory, "--no-pager", "diff", "--summary"], directory);
  assert.equal(workingCopy.stdout.trim(), "A other.md");
  await rm(directory, { recursive: true, force: true });
});

test("re-submitting an unchanged plan does not commit again", { skip: !(await hasBinary("jj")) }, async () => {
  // arrange
  const directory = await mkdtemp(join(tmpdir(), "plan-commit-"));
  const planFile = join(directory, "20260916-1628-plan.md");
  await writeFile(planFile, "# Plan\n");
  await commitPlanFile(realExecutor, planFile, "submit");

  // act
  const outcome = await commitPlanFile(realExecutor, planFile, "submit");

  // assert
  assert.deepEqual(outcome, { kind: "unchanged", vcs: "jj" });
  await rm(directory, { recursive: true, force: true });
});

test("without jj a fresh directory becomes a git repository holding only the submitted plan", { skip: !(await hasBinary("git")) }, async () => {
  // arrange
  const directory = await mkdtemp(join(tmpdir(), "plan-commit-"));
  const planFile = join(directory, "20260916-1628-plan.md");
  await writeFile(planFile, "# Plan\n");
  await writeFile(join(directory, "other.md"), "# Other\n");

  // act
  const outcome = await commitPlanFile(withoutJj, planFile, "submit");

  // assert
  assert.deepEqual(outcome, { kind: "committed", vcs: "git" });
  const committed = await realExecutor("git", ["-C", directory, "show", "--name-only", "--format=", "HEAD"], directory);
  assert.equal(committed.stdout.trim(), "20260916-1628-plan.md");
  const status = await realExecutor("git", ["-C", directory, "status", "--porcelain"], directory);
  assert.equal(status.stdout.trim(), "?? other.md");
  await rm(directory, { recursive: true, force: true });
});

test("an existing git-only repository is used as-is even when jj is available", { skip: !(await hasBinary("git")) }, async () => {
  // arrange
  const directory = await mkdtemp(join(tmpdir(), "plan-commit-"));
  await realExecutor("git", ["init", "--quiet"], directory);
  const planFile = join(directory, "20260916-1628-plan.md");
  await writeFile(planFile, "# Plan\n");

  // act
  const outcome = await commitPlanFile(realExecutor, planFile, "submit");

  // assert
  assert.deepEqual(outcome, { kind: "committed", vcs: "git" });
  await rm(directory, { recursive: true, force: true });
});

test("a review followed by a submit produces two commits with their own messages", { skip: !(await hasBinary("jj")) }, async () => {
  // arrange
  const directory = await mkdtemp(join(tmpdir(), "plan-commit-"));
  const planFile = join(directory, "20260916-1628-plan.md");
  await writeFile(planFile, "# Plan\n");
  await commitPlanFile(realExecutor, planFile, "review");
  await writeFile(planFile, "# Plan\n\nRevised.\n");

  // act
  const outcome = await commitPlanFile(realExecutor, planFile, "submit");

  // assert
  assert.deepEqual(outcome, { kind: "committed", vcs: "jj" });
  const log = await realExecutor(
    "jj",
    ["-R", directory, "--no-pager", "log", "--no-graph", "-r", "all() ~ @ ~ root()", "-T", "description"],
    directory,
  );
  assert.deepEqual(log.stdout.trim().split("\n").sort(), [
    "Review plan: 20260916-1628-plan",
    "Submit plan: 20260916-1628-plan",
  ]);
  await rm(directory, { recursive: true, force: true });
});

async function hasBinary(command: string): Promise<boolean> {
  const { code } = await realExecutor(command, ["--version"], process.cwd());
  return code === 0;
}
