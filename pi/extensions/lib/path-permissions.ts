import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readJsonObject } from "./json.ts";
import {
  defaultAllowed,
  emptyRules,
  evaluate,
  hasSerializedRuleKeys,
  parseRules,
  recordRule,
  serializeRules,
  subtree,
} from "./path-permission-rules.ts";
import type {
  AccessMode,
  PathRule,
  RuleSets,
  RuleTier,
  SerializedRules,
} from "./path-permission-rules.ts";
import { getCurrentPlanPath } from "./plan-file.ts";
import {
  contains,
  expandHome,
  findRepoRoot,
  isVcsInternal,
  memoryDirectory,
  resolveThroughSymlinks,
  skillRoots,
} from "./repo.ts";
import { serialize } from "./ui-queue.ts";

export type {
  AccessMode,
  PathRule,
  RuleKind,
  RuleSets,
  RuleTier,
  SerializedRules,
  Verdict,
} from "./path-permission-rules.ts";

export const PATH_RULES_ENTRY_TYPE = "path-permissions";

const RULES_FILE = join(getAgentDir(), "path-permissions.json");
const LEGACY_SCOPE_FILE = join(getAgentDir(), "repo-scope.json");

const ALLOW_ONCE = "Allow once";
const ALLOW_SESSION = "Allow in session";
const ALLOW_ALWAYS = "Allow always";
const DENY_ONCE = "Deny once";
const DENY_SESSION = "Deny in session";
const DENY_ALWAYS = "Deny always";

interface SharedState {
  session: RuleSets;
  always?: RuleSets;
  alwaysLoad?: Promise<RuleSets>;
  planMode: boolean;
  persistSession?: (snapshot: SerializedRules) => void;
}

const globalState = globalThis as {
  piPathPermissions?: SharedState;
};
const state = (globalState.piPathPermissions ??= {
  session: emptyRules(),
  planMode: false,
});

export function setPlanModeEnabled(enabled: boolean): void {
  state.planMode = enabled;
}

export function isPlanModeEnabled(): boolean {
  return state.planMode;
}

export function initPathPermissions(pi: ExtensionAPI): void {
  state.persistSession = (snapshot) => {
    pi.appendEntry(PATH_RULES_ENTRY_TYPE, snapshot);
  };
}

export function restoreSessionPathRules(sessionManager: {
  getEntries(): readonly unknown[];
}): void {
  const entries = sessionManager.getEntries() as readonly {
    type?: unknown;
    customType?: unknown;
    data?: unknown;
  }[];
  const entry = entries
    .filter(
      (candidate) =>
        candidate.type === "custom" &&
        candidate.customType === PATH_RULES_ENTRY_TYPE,
    )
    .pop();
  state.session = parseRules(entry?.data);
}

export const PathResolution = {
  Follow: "follow",
  PreserveFinalSymlink: "preserve-final-symlink",
} as const;
export type PathResolution =
  (typeof PathResolution)[keyof typeof PathResolution];

export function gatedTool(
  definition: ToolDefinition<any, any, any>,
  mode: AccessMode,
  resolution: PathResolution = PathResolution.Follow,
): ToolDefinition<any, any, any> {
  return {
    ...definition,
    async execute(toolCallId, params, signal, onUpdate, context) {
      const { path } = params as { path?: string };
      const resolved = await ensurePathAccess(
        path ?? context.cwd,
        mode,
        context,
        resolution,
      );
      return await definition.execute(
        toolCallId,
        { ...(params as Record<string, unknown>), path: resolved },
        signal,
        onUpdate,
        context,
      );
    },
  };
}

export async function ensurePathAccess(
  target: string,
  mode: AccessMode,
  context: ExtensionContext,
  resolution: PathResolution = PathResolution.Follow,
): Promise<string> {
  const anchored = anchorTarget(target, context.cwd);
  const resolved = await resolveThroughSymlinks(anchored);
  const operationPath =
    resolution === PathResolution.PreserveFinalSymlink
      ? await resolveParentThroughSymlinks(anchored)
      : resolved;
  const checkedPaths = [...new Set([resolved, operationPath])];

  for (const path of checkedPaths) {
    assertWritablePath(path, mode);
  }

  const always = await loadAlways();
  const defaults = await currentDefaults(mode);
  for (const path of checkedPaths) {
    const verdict = evaluate(path, mode, {
      defaults,
      always,
      session: state.session,
    });
    if (verdict === "deny") throw deniedError(path, mode);
  }
  for (const path of checkedPaths) {
    await ensureAllowed(path, mode, context, defaults, always);
  }
  return operationPath;
}


function anchorTarget(target: string, cwd: string): string {
  const expanded = expandHome(target);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

async function resolveParentThroughSymlinks(target: string): Promise<string> {
  return join(await resolveThroughSymlinks(dirname(target)), basename(target));
}

function assertWritablePath(path: string, mode: AccessMode): void {
  if (mode !== "write" || !isVcsInternal(path)) return;
  throw new Error(
    `${path} is inside a version control directory. Reading and searching .git and .jj is fine, ` +
      "but writing to them is not. Use the vcs_* tools to inspect history, or jj/git via bash to change it.",
  );
}

async function ensureAllowed(
  path: string,
  mode: AccessMode,
  context: ExtensionContext,
  defaults: string[],
  always: RuleSets,
): Promise<void> {
  const verdict = () =>
    evaluate(path, mode, { defaults, always, session: state.session });
  if (verdict() === "deny") throw deniedError(path, mode);
  if (verdict() === "allow") return;

  await serialize(async () => {
    if (verdict() === "deny") throw deniedError(path, mode);
    if (verdict() === "allow") return;
    await requestAccess(path, mode, context);
  });
}

async function currentDefaults(mode: AccessMode): Promise<string[]> {
  const repoRoot = await resolveThroughSymlinks(findRepoRoot());
  const [memoryRoot, planPath, resolvedSkills, agentDirectory] =
    await Promise.all([
      resolveThroughSymlinks(memoryDirectory()),
      resolvePlanPath(),
      resolvedSkillRoots(repoRoot),
      resolveThroughSymlinks(getAgentDir()),
    ]);
  return defaultAllowed(mode, {
    planMode: state.planMode,
    repoRoot,
    memoryDirectory: memoryRoot,
    planPath,
    skillRoots: resolvedSkills,
    agentDirectory,
  });
}

async function resolvePlanPath(): Promise<string | undefined> {
  const planPath = getCurrentPlanPath();
  return planPath === undefined
    ? undefined
    : await resolveThroughSymlinks(planPath);
}

// Project skill roots are only trusted while their canonical path stays in the repository.
// Global roots and their direct entries are installed by the user, so symlinked skills there
// retain default read access without letting a repository symlink widen the read boundary.
async function resolvedSkillRoots(repoRoot: string): Promise<string[]> {
  const roots = [...skillRoots()];
  const resolved = new Set<string>();
  for (const [index, root] of roots.entries()) {
    const resolvedRoot = await resolveThroughSymlinks(root);
    if (index >= 2 || contains(repoRoot, resolvedRoot)) {
      resolved.add(resolvedRoot);
    }
  }
  for (const root of roots.slice(2)) {
    const entries = await readdir(root).catch(() => [] as string[]);
    for (const entry of entries) {
      resolved.add(await resolveThroughSymlinks(join(root, entry)));
    }
  }
  return [...resolved];
}

async function requestAccess(
  resolved: string,
  mode: AccessMode,
  context: ExtensionContext,
): Promise<string> {
  if (!context.hasUI) {
    throw new Error(
      `${resolved} is not covered by the ${mode} path rules and there is no interactive UI to ask. Stay inside the repository.`,
    );
  }
  const grantRoot = await grantRootFor(resolved);
  const pattern = subtree(grantRoot);
  const verb = mode === "read" ? "Read" : "Write";
  const choice = await context.ui.select(
    `${verb} ${resolved}?\n\n  Allowing grants ${mode} access to ${pattern}\n  Denying blocks ${mode} access to ${pattern}`,
    [
      ALLOW_ONCE,
      ALLOW_SESSION,
      ALLOW_ALWAYS,
      DENY_ONCE,
      DENY_SESSION,
      DENY_ALWAYS,
    ],
  );

  switch (choice) {
    case ALLOW_ONCE:
      return resolved;
    case ALLOW_SESSION:
      await addPathRule({ mode, kind: "allow", tier: "session", pattern });
      return resolved;
    case ALLOW_ALWAYS:
      await addPathRule({ mode, kind: "allow", tier: "always", pattern });
      return resolved;
    case DENY_SESSION:
      await addPathRule({ mode, kind: "deny", tier: "session", pattern });
      throw deniedError(resolved, mode);
    case DENY_ALWAYS:
      await addPathRule({ mode, kind: "deny", tier: "always", pattern });
      throw deniedError(resolved, mode);
    default:
      throw deniedError(resolved, mode);
  }
}

async function grantRootFor(path: string): Promise<string> {
  const stats = await stat(path).catch(() => undefined);
  return findRepoRoot(stats?.isDirectory() ? path : dirname(path));
}

export async function listPathRules(): Promise<PathRule[]> {
  const rules: PathRule[] = [];
  const tiers: [RuleTier, RuleSets][] = [
    ["session", state.session],
    ["always", await loadAlways()],
  ];
  for (const [tier, sets] of tiers) {
    for (const mode of ["read", "write"] as const) {
      for (const kind of ["allow", "deny"] as const) {
        for (const pattern of [...sets[mode][kind]].sort()) {
          rules.push({ mode, kind, tier, pattern });
        }
      }
    }
  }
  return rules;
}

export async function addPathRule(rule: PathRule): Promise<void> {
  const always = await loadAlways();
  const changedTiers = recordRule(rule, {
    session: state.session,
    always,
  });
  for (const tier of changedTiers) {
    await persistTier(tier);
  }
}

export async function removePathRule(rule: PathRule): Promise<void> {
  const rules = await rulesForTier(rule.tier);
  rules[rule.mode][rule.kind].delete(rule.pattern);
  await persistTier(rule.tier);
}

export async function clearPathRules(): Promise<void> {
  await loadAlways();
  state.session = emptyRules();
  state.always = emptyRules();
  state.alwaysLoad = Promise.resolve(state.always);
  await persistTier("session");
  await persistTier("always");
}

function deniedError(resolved: string, mode: AccessMode): Error {
  return new Error(
    `${resolved} is denied for ${mode} access by the path rules. ` +
      "Do not retry this path and do not route around it with a different tool. " +
      "Say what you need it for so the user can allow it.",
  );
}

async function rulesForTier(tier: RuleTier): Promise<RuleSets> {
  return tier === "session" ? state.session : await loadAlways();
}

async function persistTier(tier: RuleTier): Promise<void> {
  if (tier === "session") {
    state.persistSession?.(serializeRules(state.session));
    return;
  }

  await mkdir(dirname(RULES_FILE), { recursive: true });
  await writeFile(
    RULES_FILE,
    `${JSON.stringify(serializeRules(await loadAlways()), null, 2)}\n`,
  );
}

function loadAlways(): Promise<RuleSets> {
  if (state.always !== undefined) return Promise.resolve(state.always);
  state.alwaysLoad ??= readAlways().then((rules) => {
    state.always = rules;
    return rules;
  });
  return state.alwaysLoad;
}

async function readAlways(): Promise<RuleSets> {
  const parsed = await readJsonObject(RULES_FILE);
  if (hasSerializedRuleKeys(parsed)) return parseRules(parsed);

  const legacy = await readJsonObject(LEGACY_SCOPE_FILE);
  const rules = emptyRules();
  for (const root of legacyRoots(legacy.readRoots)) {
    rules.read.allow.add(subtree(root));
  }
  for (const root of legacyRoots(legacy.writeRoots)) {
    rules.write.allow.add(subtree(root));
  }
  if (rules.read.allow.size > 0 || rules.write.allow.size > 0) {
    await mkdir(dirname(RULES_FILE), { recursive: true });
    await writeFile(
      RULES_FILE,
      `${JSON.stringify(serializeRules(rules), null, 2)}\n`,
    );
  }
  return rules;
}

function legacyRoots(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => resolve(expandHome(item)))
    : [];
}
