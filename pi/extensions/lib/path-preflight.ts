import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { PathAuthorization, GatedScope } from "./path-permissions.ts";
import { evaluate } from "./path-permission-rules.ts";

export async function preflightPath(authorization: PathAuthorization, scope: GatedScope, signal?: AbortSignal): Promise<void> {
  if (scope === "root") return;
  const rootStats = await lstat(authorization.operationPath).catch((error) => { throw new Error(`Path preflight failed: ${error.message}`); });
  if (!rootStats.isDirectory()) return;
  const queue = [authorization.operationPath];
  while (queue.length > 0) {
    if (signal?.aborted) throw new Error("Path preflight aborted");
    const directory = queue.shift()!;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { throw new Error(`Path preflight failed: ${error instanceof Error ? error.message : String(error)}`); }
    for (const entry of entries) {
      if (signal?.aborted) throw new Error("Path preflight aborted");
      // The gated tools never follow symlinks during discovery (fd and rg run without --follow),
      // so a link only exposes its own name, which lives under the already authorized root.
      // Resolving it would wrongly reject links such as Bazel's bazel-out pointing out of the repo.
      if (entry.isSymbolicLink()) continue;
      // The root is canonical and no symlink was crossed to reach this entry, so the joined
      // path is canonical too and needs no per-entry resolution.
      const encountered = join(directory, entry.name);
      const verdict = evaluatePath(encountered, authorization);
      if (verdict !== "allow") throw new Error(`Path preflight rejected ${encountered} (${describeVerdict(verdict)}) while checking ${authorization.operationPath}.`);
      if (entry.isDirectory() && scope === "recursive") queue.push(encountered);
    }
  }
}

function evaluatePath(path: string, authorization: PathAuthorization) {
  return evaluate(path, authorization.mode, { defaults: authorization.defaults, always: authorization.always, session: authorization.session });
}

function describeVerdict(verdict: "deny" | "prompt"): string {
  return verdict === "deny" ? "denied by the path rules" : "not covered by the path rules";
}
