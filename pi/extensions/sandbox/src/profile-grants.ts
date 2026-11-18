import { join } from "node:path";
import { isRestricted } from "../../lib/agent-mode.ts";
import type { AgentMode } from "../../lib/agent-mode.ts";
import type { PathSelector } from "../../lib/path-permission-rules.ts";
import type { OnceGrant } from "../../lib/path-permissions.ts";
import { contains } from "../../lib/repo.ts";
import { profileFingerprint } from "./profiles.ts";
import type { Profile } from "./profiles.ts";
import { expandHome } from "../../lib/path-resolution.ts";

export interface ProfileInputs {
  agentMode: AgentMode;
  repositoryRoot: string;
  stateDirectory: string;
  homeDirectory: string;
  // One id per pi process, i.e. per lifetime of srt's proxy.
  instance: string;
}

// In plan and explore mode the repository stays read-only even when a profile entry is broad enough to cover it.
export function withoutRepositoryWrites(grants: readonly OnceGrant[], repositoryRoot: string, agentMode: AgentMode): OnceGrant[] {
  if (!isRestricted(agentMode)) return [...grants];
  return grants.filter(({ mode, selector }) => {
    if (mode !== "write") return true;
    const root = selectorRoot(selector);
    return !contains(root, repositoryRoot) && !contains(repositoryRoot, root);
  });
}

export function profileEnvironment(base: NodeJS.ProcessEnv, profiles: readonly Profile[], inputs: ProfileInputs): NodeJS.ProcessEnv {
  const shimDirectories = profiles.flatMap(({ path }) => path.map((directory) => expandHome(directory, inputs.homeDirectory)));
  return {
    ...base,
    PATH: [...shimDirectories, ...(base.PATH ? [base.PATH] : [])].join(":"),
    PI_SANDBOX_PROFILE_FINGERPRINT: profileFingerprint(profiles),
    PI_SANDBOX_INSTANCE: inputs.instance,
    PI_SANDBOX_STATE_DIR: inputs.stateDirectory,
  };
}

export function stateDirectoryIn(agentDirectory: string): string {
  return join(agentDirectory, "sandbox-state");
}

function selectorRoot(selector: PathSelector): string {
  return selector.kind === "glob" ? selector.base : selector.path;
}
