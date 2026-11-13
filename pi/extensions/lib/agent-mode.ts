export const AgentMode = { Execution: "execution", Planning: "planning", Exploring: "exploring" } as const;
export type AgentMode = (typeof AgentMode)[keyof typeof AgentMode];
export type RestrictedMode = Exclude<AgentMode, typeof AgentMode.Execution>;

// Shared by the mode message and the subagent system prompt, so children get the same wording.
export const READ_ONLY_JJ_NOTE =
  "The repository is read-only, so jj cannot snapshot the working copy: pass --ignore-working-copy to every jj command. jj then shows the working copy as of its last snapshot, which can miss the newest edits.";

// Each agent mode has its own path rules; the values are the sub-field names in the rules file and the session entry.
export const PathRuleStore = { Execution: "execution", Plan: "plan", Explore: "explore" } as const;
export type PathRuleStore = (typeof PathRuleStore)[keyof typeof PathRuleStore];

export interface ModeIdentity {
  mode: RestrictedMode;
  label: string;
  // Also the name of the startup flag.
  command: string;
  entryType: string;
  // Relative to the agent directory.
  decisionsFileName: string;
  statusIcon: string;
}

// The plan-mode entry type and file name predate explore mode and stay as they were, so existing sessions and decisions keep working.
export const MODE_IDENTITIES: Record<RestrictedMode, ModeIdentity> = {
  [AgentMode.Planning]: {
    mode: AgentMode.Planning,
    label: "Plan mode",
    command: "plan",
    entryType: "plan-mode",
    decisionsFileName: "plan-mode.json",
    statusIcon: "📝",
  },
  [AgentMode.Exploring]: {
    mode: AgentMode.Exploring,
    label: "Explore mode",
    command: "explore",
    entryType: "explore-mode",
    decisionsFileName: "explore-mode.json",
    statusIcon: "🔍",
  },
};

export const RESTRICTED_MODES: readonly RestrictedMode[] = [AgentMode.Planning, AgentMode.Exploring];

export function isRestricted(mode: AgentMode): mode is RestrictedMode {
  return mode !== AgentMode.Execution;
}

const MODE_RULE_STORES: Record<AgentMode, PathRuleStore> = {
  [AgentMode.Execution]: PathRuleStore.Execution,
  [AgentMode.Planning]: PathRuleStore.Plan,
  [AgentMode.Exploring]: PathRuleStore.Explore,
};

export function storeForMode(mode: AgentMode): PathRuleStore {
  return MODE_RULE_STORES[mode];
}

export function isPathRuleStore(value: string | undefined): value is PathRuleStore {
  return (Object.values(PathRuleStore) as (string | undefined)[]).includes(value);
}
