import { dirname, basename, relative } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { detectVcs } from "./repo.ts";

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type Executor = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<CommandResult>;

export type RepositoryKind = "jj" | "git";

export interface Invocation {
  command: string;
  args: string[];
}

export type CommitOutcome =
  | { kind: "committed"; vcs: RepositoryKind }
  | { kind: "unchanged"; vcs: RepositoryKind };

export type CommitReason = "submit" | "review";

// The commit is bookkeeping for the user, not something the model can act on, so
// failures surface as a UI warning and never change the tool result.
export async function commitPlanFileForUser(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  planFile: string,
  reason: CommitReason,
): Promise<void> {
  const TIMEOUT_MS = 30_000;
  const execute: Executor = (command, args, cwd) =>
    pi.exec(command, args, { cwd, timeout: TIMEOUT_MS });
  try {
    await commitPlanFile(execute, planFile, reason);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Plan file not committed: ${message}`, "warning");
  }
}

// Commits exactly the plan file into the repository containing it, creating one in the
// plan directory when there is none. Throws on any command failure; the caller decides
// how loud to be about it.
export async function commitPlanFile(
  execute: Executor,
  planFile: string,
  reason: CommitReason,
): Promise<CommitOutcome> {
  const directory = dirname(planFile);
  const detected = detectVcs(directory);

  let vcs: RepositoryKind;
  let root: string;
  if (detected.kind === "none") {
    vcs = (await isAvailable(execute, "jj")) ? "jj" : "git";
    root = directory;
    await run(execute, initInvocation(vcs), root);
  } else {
    vcs = detected.kind;
    root = detected.root;
  }

  const path = relative(root, planFile);
  const status = await run(execute, statusInvocation(vcs, root, path), root);
  if (isUnchanged(status.stdout)) return { kind: "unchanged", vcs };

  for (const invocation of commitInvocations(vcs, root, path, commitMessage(planFile, reason))) {
    await run(execute, invocation, root);
  }
  return { kind: "committed", vcs };
}

export function initInvocation(vcs: RepositoryKind): Invocation {
  return vcs === "jj"
    ? { command: "jj", args: ["git", "init", "--colocate"] }
    : { command: "git", args: ["init", "--quiet"] };
}

// Both commands print one line per changed path and nothing when the path is clean.
export function statusInvocation(vcs: RepositoryKind, root: string, path: string): Invocation {
  return vcs === "jj"
    ? { command: "jj", args: [...jjGlobalArgs(root), "diff", "--summary", path] }
    : { command: "git", args: [...gitGlobalArgs(root), "status", "--porcelain", "--", path] };
}

export function isUnchanged(statusOutput: string): boolean {
  return statusOutput.trim() === "";
}

export function commitInvocations(
  vcs: RepositoryKind,
  root: string,
  path: string,
  message: string,
): Invocation[] {
  if (vcs === "jj") {
    return [
      { command: "jj", args: [...jjGlobalArgs(root), "file", "track", path] },
      { command: "jj", args: [...jjGlobalArgs(root), "commit", "-m", message, path] },
    ];
  }
  return [
    { command: "git", args: [...gitGlobalArgs(root), "add", "--", path] },
    { command: "git", args: [...gitGlobalArgs(root), "commit", "--quiet", "-m", message, "--", path] },
  ];
}

export function commitMessage(planFile: string, reason: CommitReason): string {
  const prefix = reason === "submit" ? "Submit plan" : "Review plan";
  return `${prefix}: ${basename(planFile, ".md")}`;
}

// -R / -C pin the command to the detected root the same way lib/vcs.ts does, so the
// process cwd can never redirect the commit into another repository.
function jjGlobalArgs(root: string): string[] {
  return ["-R", root, "--color=never", "--no-pager"];
}

function gitGlobalArgs(root: string): string[] {
  return ["-C", root, "--no-pager", "-c", "color.ui=false"];
}

async function isAvailable(execute: Executor, command: string): Promise<boolean> {
  const { code } = await execute(command, ["--version"], process.cwd());
  return code === 0;
}

async function run(execute: Executor, invocation: Invocation, cwd: string): Promise<CommandResult> {
  const result = await execute(invocation.command, invocation.args, cwd);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    throw new Error(`${invocation.command} ${invocation.args.join(" ")} failed: ${detail}`);
  }
  return result;
}
