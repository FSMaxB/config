export const AgentMode = { Execution: "execution", Planning: "planning", Exploring: "exploring" } as const;
export type AgentMode = (typeof AgentMode)[keyof typeof AgentMode];
export type RestrictedMode = Exclude<AgentMode, typeof AgentMode.Execution>;

// Plan mode shares the path-rule store with normal execution; explore mode has its own.
export const PathRuleStore = { Shared: "shared", Explore: "explore" } as const;
export type PathRuleStore = (typeof PathRuleStore)[keyof typeof PathRuleStore];

export interface ModeIdentity {
  mode: RestrictedMode;
  label: string;
  // Also the name of the startup flag.
  command: string;
  entryType: string;
  // Relative to the agent directory.
  decisionsFileName: string;
  pathRuleStore: PathRuleStore;
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
    pathRuleStore: PathRuleStore.Shared,
    statusIcon: "⏸",
  },
  [AgentMode.Exploring]: {
    mode: AgentMode.Exploring,
    label: "Explore mode",
    command: "explore",
    entryType: "explore-mode",
    decisionsFileName: "explore-mode.json",
    pathRuleStore: PathRuleStore.Explore,
    statusIcon: "🔍",
  },
};

export const RESTRICTED_MODES: readonly RestrictedMode[] = [AgentMode.Planning, AgentMode.Exploring];

export function storeForMode(mode: AgentMode): PathRuleStore {
  return mode === AgentMode.Exploring ? PathRuleStore.Explore : PathRuleStore.Shared;
}

export function isRestricted(mode: AgentMode): mode is RestrictedMode {
  return mode !== AgentMode.Execution;
}
