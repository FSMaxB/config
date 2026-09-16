import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { sep } from "node:path";
import type { PathAuthorization, GatedScope } from "./path-permissions.ts";
import { evaluate, type Verdict } from "./path-permission-rules.ts";
import { insideGitRepository, locateBinary } from "./search-binaries.ts";

export async function preflightPath(authorization: PathAuthorization, scope: GatedScope, signal?: AbortSignal): Promise<void> {
  if (scope === "root") return;
  const root = authorization.operationPath;
  const rootStats = await lstat(root).catch((error) => { throw new Error(`Path preflight failed: ${error.message}`); });
  if (!rootStats.isDirectory()) return;
  const rejected = await firstRejectedEntry(root, scope, authorization, signal);
  if (!rejected) return;
  throw new Error(`Path preflight rejected ${rejected.path} (${describeVerdict(rejected.verdict)}) while checking ${root}.`);
}

interface RejectedEntry { path: string; verdict: Exclude<Verdict, "allow"> }

// fd is the discovery engine the find tool itself uses and rg shares its ignore semantics, so
// enumerating with it yields exactly the entries a search would touch: .gitignore is honored,
// symlinks are not followed (no --follow, and --type f/d excludes the links themselves), and
// version control internals are pruned while the .git/.jj directory itself stays listed so a
// rule denying it as a whole still applies.
function firstRejectedEntry(root: string, scope: GatedScope, authorization: PathAuthorization, signal?: AbortSignal): Promise<RejectedEntry | undefined> {
  const fd = locateBinary("fd", ["fdfind"]);
  const args = ["--hidden", "--color=never", "--type", "f", "--type", "d", "--exclude", "**/.git/*", "--exclude", "**/.jj/*", "--print0"];
  if (scope === "children") args.push("--max-depth", "1");
  if (!insideGitRepository(root)) args.push("--no-require-git");
  // A regex pattern, not --glob: "." matches every name.
  args.push("--", ".", root);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Path preflight aborted")); return; }
    const child = spawn(fd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderrText = "", remainder = "", sawEntry = false;
    let rejected: RejectedEntry | undefined;

    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      if (rejected) return;
      // --print0 output can be split mid-path across chunks; the last piece is always incomplete.
      const pieces = (remainder + chunk.toString()).split("\0");
      remainder = pieces.pop() ?? "";
      for (const piece of pieces) {
        if (piece === "") continue;
        sawEntry = true;
        const path = stripTrailingSeparator(piece);
        const verdict = evaluatePath(path, authorization);
        if (verdict === "allow") continue;
        rejected = { path, verdict };
        child.kill();
        return;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderrText += chunk.toString(); });
    child.on("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(new Error(`Path preflight failed: ${error.message}`));
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) { reject(new Error("Path preflight aborted")); return; }
      if (rejected) { resolve(rejected); return; }
      // Mirrors the find tool: fd exits non-zero for unreadable subtrees but still lists the rest,
      // and whatever it could not read the search could not read either.
      if (code !== 0 && !sawEntry) { reject(new Error(`Path preflight failed: ${stderrText.trim() || `fd exited with code ${code}`}`)); return; }
      resolve(undefined);
    });
  });
}

// fd prints directories with a trailing separator, which would never match an exact rule.
function stripTrailingSeparator(path: string): string {
  return path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path;
}

function evaluatePath(path: string, authorization: PathAuthorization): Verdict {
  return evaluate(path, authorization.mode, { defaults: authorization.defaults, always: authorization.always, session: authorization.session });
}

function describeVerdict(verdict: Exclude<Verdict, "allow">): string {
  return verdict === "deny" ? "denied by the path rules" : "not covered by the path rules";
}
