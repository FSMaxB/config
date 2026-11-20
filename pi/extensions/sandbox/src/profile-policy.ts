import { mkdir } from "node:fs/promises";
import { tree } from "../../lib/path-permission-rules.ts";
import type { PathSelector } from "../../lib/path-permission-rules.ts";
import { normalizePathSelector } from "../../lib/path-permissions.ts";
import type { OnceGrant } from "../../lib/path-permissions.ts";
import { resolveThroughSymlinks } from "../../lib/repo.ts";
import type { ProfileInputs } from "./profile-grants.ts";
import type { Profile } from "./profiles.ts";
import { expandHome } from "../../lib/path-resolution.ts";

// Profile paths enter the policy as once grants. The shim reads and writes its state through the
// state directory, so that is granted for writing whenever a profile applies.
export async function profileGrants(profiles: readonly Profile[], inputs: ProfileInputs): Promise<OnceGrant[]> {
  if (profiles.length === 0) return [];
  const { homeDirectory, repositoryRoot } = inputs;
  const selector = (entry: string) => normalizePathSelector(entry, repositoryRoot);
  const grants: OnceGrant[] = [];
  for (const { filesystem, path } of profiles) {
    for (const entry of filesystem.read) grants.push({ mode: "read", selector: await selector(entry) });
    for (const entry of filesystem.write) grants.push({ mode: "write", selector: await selector(entry) });
    for (const directory of path) grants.push({ mode: "read", selector: tree(await resolveThroughSymlinks(expandHome(directory, homeDirectory))) });
  }
  await mkdir(inputs.stateDirectory, { recursive: true });
  grants.push({ mode: "write", selector: tree(await resolveThroughSymlinks(inputs.stateDirectory)) });
  return grants;
}

// Kept out of the once grants: filesystemConfig drops every grant that reaches a secret.
export async function profileSecretReads(profiles: readonly Profile[], repositoryRoot: string): Promise<PathSelector[]> {
  const entries = profiles.flatMap(({ filesystem }) => filesystem.secretRead);
  return await Promise.all(entries.map((entry) => normalizePathSelector(entry, repositoryRoot)));
}
