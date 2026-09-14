import { lstat, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PathAuthorization, GatedScope } from "./path-permissions.ts";
import { evaluate } from "./path-permission-rules.ts";
import { readStoredRules } from "./path-rule-store.ts";
import { resolveThroughSymlinks } from "./path-resolution.ts";

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
      const encountered = join(directory, entry.name);
      const canonical = await resolveThroughSymlinks(encountered).catch((error) => { throw new Error(`Path preflight failed: ${error instanceof Error ? error.message : String(error)}`); });
      const verdict = evaluatePath(canonical, authorization);
      if (verdict !== "allow") throw new Error(`Path preflight rejected an uncovered or denied descendant of ${authorization.operationPath}.`);
      if (entry.isDirectory() && !entry.isSymbolicLink() && scope === "recursive") queue.push(encountered);
    }
  }
}

function evaluatePath(path: string, authorization: PathAuthorization) {
  return evaluate(path, authorization.mode, { defaults: authorization.defaults, always: authorization.always, session: authorization.session });
}
