import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { covers, coveredProtectedSelectors, defaultAllowed, denyNote, emptyRules, emptyStoredRules, EntryKind, evaluate, exact, glob, matchesRule, narrowerSelectors, parseStoredRules, readOnlyRepositoryNotice, recordRule, selectorFromKey, selectorKey, selectorLabel, serializeRules, serializeStoredRules, sessionGrantsFromRules, tree } from "./path-permission-rules.ts";
import type { AccessMode, PathSelector, PathRule, RuleSets, RuleTier, SerializedStoredRules, StoredRules } from "./path-permission-rules.ts";
import { AgentMode, storeForMode } from "./agent-mode.ts";
import type { PathRuleStore } from "./agent-mode.ts";
import { expandHome } from "./path-resolution.ts";
import { readStoredRules, transaction } from "./path-rule-store.ts";
import { contains, findRepositoryRoot, isVcsInternal, memoryDirectory, resolveThroughSymlinks } from "./repo.ts";
import { latestCustomData } from "./session-entries.ts";
import { serialize } from "./ui-queue.ts";
import { CHILD_POLICY_ENV, inheritedRules, parseChildPathPolicy } from "./path-permission-snapshot.ts";
import type { ChildPathPolicy, InheritedPolicy } from "./path-permission-snapshot.ts";
import { profileDestinations } from "./permission-choices.ts";
import { ALL_DURATIONS, askPermission, Duration, userReason } from "./permission-prompt.ts";
import type { ScopeChoice } from "./permission-prompt.ts";
import { permissionUI } from "./permission-ui.ts";
import { announceSessionGrantsChanged } from "./session-grants.ts";
import type { SessionGrant } from "./session-grants.ts";
import { isRecord, stringProperty } from "./untyped.ts";
const RULES_FILE = join(getAgentDir(), "path-permissions.json");
const RULES_ENTRY_TYPE = "path-permissions";
interface SharedState { sessions: StoredRules; agentMode: AgentMode; temporaryDirectory: string | undefined; inherited: InheritedPolicy; persistSession: ((snapshot: SerializedStoredRules) => void) | undefined }
// Every extension that imports this module shares one state per process, even when pi loads the module more than once.
const globalState = globalThis as { piPathPermissions?: SharedState };
const state = (globalState.piPathPermissions ??= { sessions: emptyStoredRules(), agentMode: AgentMode.Execution, temporaryDirectory: undefined, inherited: parseChildPathPolicy(process.env[CHILD_POLICY_ENV]), persistSession: undefined });
export function setAgentMode(mode: AgentMode): void { state.agentMode = mode; }
// A subagent runs in execution mode but must apply the defaults and notices of the mode it was dispatched from.
export function currentAgentMode(): AgentMode { return parentPolicy()?.agentMode ?? state.agentMode; }
// A subagent is always in execution mode but must enforce the store its parent was using.
export function activePathRuleStore(): PathRuleStore { return parentPolicy()?.ruleStore ?? storeForMode(state.agentMode); }
function parentPolicy(): ChildPathPolicy | undefined { return state.inherited.kind === "valid" ? state.inherited.policy : undefined; }
export function setSessionTemporaryDirectory(path: string): void { state.temporaryDirectory = path; }
export function initPathPermissions(pi: ExtensionAPI): void { state.persistSession = (snapshot) => { pi.appendEntry(RULES_ENTRY_TYPE, snapshot); announceSessionGrantsChanged(pi.events); }; }
export function restoreSessionPathRules(sessionManager: { getEntries(): readonly unknown[] }): void {
  state.sessions = parseSession(latestCustomData(sessionManager, RULES_ENTRY_TYPE));
}
// Only the active mode's rules apply. A subagent's inherited rules are left out: subagents have no UI to show them.
export function activeSessionPathGrants(): SessionGrant[] { return sessionGrantsFromRules(state.sessions[activePathRuleStore()]); }

export const PathResolution = { Follow: "follow", PreserveFinalSymlink: "preserve-final-symlink" } as const;
export type PathResolution = (typeof PathResolution)[keyof typeof PathResolution];
export type GatedScope = "root" | "children" | "recursive";

// Every gated tool takes the path it works on in a `path` parameter.
export function gatedTool<TParameters extends TSchema, TDetails>(definition: ToolDefinition<TParameters, TDetails>, mode: AccessMode, resolution: PathResolution = PathResolution.Follow, scope: GatedScope = "root"): ToolDefinition<TParameters, TDetails> {
  return { ...definition, async execute(toolCallId, parameters, signal, onUpdate, context) {
    const path = isRecord(parameters) ? stringProperty(parameters, "path") : undefined;
    const authorization = await authorizeRoot(path ?? context.cwd, mode, context, resolution);
    if (scope !== "root") {
      const { preflightPath } = await import("./path-preflight.ts");
      await preflightPath(authorization, scope, signal);
    }
    return await definition.execute(toolCallId, { ...parameters, path: authorization.operationPath }, signal, onUpdate, context);
  } };
}

export interface PathAuthorization { operationPath: string; checkedPaths: string[]; mode: AccessMode; context: ExtensionContext; defaults: ReturnType<typeof defaultAllowed>; session: RuleSets; always: RuleSets; protected: PathSelector[]; }
export async function authorizeRoot(target: string, mode: AccessMode, context: ExtensionContext, resolution: PathResolution = PathResolution.Follow): Promise<PathAuthorization> {
  if (state.inherited.kind === "invalid") throw new Error("The inherited child path policy is invalid; path tools are disabled.");
  const anchored = anchorTarget(target, context.cwd);
  const resolved = await resolveThroughSymlinks(anchored);
  const operationPath = resolution === PathResolution.PreserveFinalSymlink ? join(await resolveThroughSymlinks(dirname(anchored)), basename(anchored)) : resolved;
  const checkedPaths = [...new Set([resolved, operationPath])];
  for (const path of checkedPaths) assertWritablePath(path, mode);
  const layers = await effectiveLayers(mode);
  for (const path of checkedPaths) if (evaluate(path, mode, layers) === "deny") throw deniedError(path, mode, denyNote(path, mode, layers));
  for (const path of checkedPaths) await ensureAllowed(path, mode, context, layers);
  const { defaults, session, always, protected: protectedSelectors } = layers;
  return { operationPath, checkedPaths, mode, context, defaults, session, always, protected: protectedSelectors };
}

export interface ModePolicy { allow: PathSelector[]; deny: PathSelector[]; protected: PathSelector[] }
export interface EffectivePolicy { read: ModePolicy; write: ModePolicy }

// The merged view per mode, for enforcement outside this process (the bash sandbox).
export async function currentPolicy(onceGrants: readonly OnceGrant[] = []): Promise<EffectivePolicy> {
  if (state.inherited.kind === "invalid") throw new Error("The inherited child path policy is invalid; the sandbox cannot be configured.");
  return { read: await modePolicy("read", onceGrants), write: await modePolicy("write", onceGrants) };
}

// Used by the sandbox after a command was denied. "Allow once" records nothing: the sandbox reruns the command with the returned grant.
// Only the sandbox passes profiles, which adds an "Add to profile" choice; the file tools keep the plain prompt.
// The sandbox passes LASTING_DURATIONS for a command that exited 0, which it never reruns.
export async function grantPathAccess(path: string, mode: AccessMode, context: ExtensionContext, profiles: readonly string[] = [], durations: readonly Duration[] = ALL_DURATIONS): Promise<PathAccessOutcome> {
  const resolved = await resolveThroughSymlinks(path);
  const settled = async (): Promise<PathAccessOutcome | undefined> => {
    const layers = await effectiveLayers(mode);
    const verdict = evaluate(resolved, mode, layers);
    if (verdict === "prompt") return undefined;
    return verdict === "allow" ? { kind: "allowed" } : { kind: "denied", note: denyNote(resolved, mode, layers) };
  };
  const immediate = await settled();
  if (immediate) return immediate;
  return await serialize(async () => {
    const latest = await settled();
    if (latest) return latest;
    const { protected: protectedSelectors } = await effectiveLayers(mode);
    try {
      const answer = await requestAccess(resolved, mode, context, protectedSelectors, profiles, durations);
      if (answer.kind === "once") return { kind: "allowed-once", grant: { mode, selector: answer.selector } };
      if (answer.kind === "profile") return { kind: "add-to-profile", profile: answer.profile, grant: { mode, selector: answer.selector } };
      return answer.kind === "rule" ? { kind: "allowed" } : { kind: "denied", note: answer.note };
    } catch {
      return { kind: "denied", note: undefined };
    }
  });
}

export interface OnceGrant { mode: AccessMode; selector: PathSelector }
export type PathAccessOutcome =
  | { kind: "allowed" }
  | { kind: "allowed-once"; grant: OnceGrant }
  | { kind: "denied"; note: string | undefined }
  // The caller records the grant in the profile; nothing is stored here.
  | { kind: "add-to-profile"; profile: string; grant: OnceGrant };

async function modePolicy(mode: AccessMode, onceGrants: readonly OnceGrant[]): Promise<ModePolicy> {
  const { defaults, always, session, protected: protectedSelectors } = await effectiveLayers(mode);
  const onceAllow = onceGrants.filter((grant) => grant.mode === mode).map(({ selector }) => selector);
  const explicitAllow = [...[...always[mode].allow, ...session[mode].allow].map(selectorFromKey), ...onceAllow];
  const deny = [...always[mode].deny.keys(), ...session[mode].deny.keys()].map(selectorFromKey);
  const uncovered = protectedSelectors.filter((target) => !explicitAllow.some((grant) => covers(grant, target)));
  return { allow: [...defaults, ...explicitAllow], deny, protected: uncovered };
}

async function effectiveLayers(mode: AccessMode): Promise<{ defaults: PathSelector[]; always: RuleSets; session: RuleSets; protected: PathSelector[] }> {
  const store = activePathRuleStore();
  const always = (await readStoredRules(RULES_FILE))[store];
  const parent = parentPolicy();
  const session = mergeInheritedSession(state.sessions[store], parent);
  const inheritedDefaults = parent === undefined ? [] : mode === "read" ? parent.readDefaults : parent.writeDefaults;
  const defaults = [...inheritedDefaults, ...(await currentDefaults(mode))];
  const protectedSelectors = mode === "write" ? await protectedWritePaths() : [];
  return { defaults, always, session, protected: protectedSelectors };
}

// Writable policy the agent could use to disarm the sandbox or the path rules on the next restart.
async function protectedWritePaths(): Promise<PathSelector[]> {
  const agentDirectory = getAgentDir();
  const roots = [join(agentDirectory, "extensions"), join(agentDirectory, "skills"), join(homedir(), ".agents", "skills"), join(homedir(), ".claude", "skills"), join(agentDirectory, "install"), join(agentDirectory, "bin"), join(agentDirectory, "npm")];
  const resolvedRoots = await Promise.all(roots.map((root) => resolveThroughSymlinks(root)));
  return [...new Set(resolvedRoots)].map(tree).concat(glob(await resolveThroughSymlinks(agentDirectory), "*.json"));
}

async function ensureAllowed(path: string, mode: AccessMode, context: ExtensionContext, layers: Awaited<ReturnType<typeof effectiveLayers>>): Promise<void> {
  const verdict = evaluate(path, mode, layers);
  if (verdict === "deny") throw deniedError(path, mode, denyNote(path, mode, layers));
  if (verdict === "allow") return;
  await serialize(async () => {
    // A prompt answered while this call waited in the queue may already cover the path.
    const latest = await effectiveLayers(mode);
    const latestVerdict = evaluate(path, mode, latest);
    if (latestVerdict === "deny") throw deniedError(path, mode, denyNote(path, mode, latest));
    if (latestVerdict === "allow") return;
    const answer = await requestAccess(path, mode, context, latest.protected);
    if (answer.kind === "denied") throw deniedError(path, mode, answer.note);
  });
}

async function requestAccess(resolved: string, mode: AccessMode, context: ExtensionContext, protectedSelectors: readonly PathSelector[] = [], profiles: readonly string[] = [], durations: readonly Duration[] = ALL_DURATIONS): Promise<AccessAnswer> {
  if (!context.hasUI) throw new Error(`${resolved} is not covered by the ${mode} path rules and there is no interactive UI to ask. Stay inside the repository.${readOnlyRepositoryNotice(mode, currentAgentMode())}`);
  // A protected path is granted as its own protected root, so approving one extension file does not open the whole repository.
  const protectedMatch = protectedSelectors.find((candidate) => matchesRule(resolved, candidate));
  const selector = protectedMatch ?? tree(await grantRootFor(resolved));
  const verb = mode === "read" ? "Read" : "Write";
  const subject = `${mode} access to ${selectorLabel(selector)}`;
  const covered = coveredProtectedSelectors(selector, protectedSelectors).filter((target) => target !== protectedMatch);
  const warning = covered.length === 0 ? "" :
    `\n  Warning: this also grants ${mode} access to protected paths:\n${covered.map((target) => `  - ${selectorLabel(target)}`).join("\n")}`;
  const answer = await askPermission(permissionUI(context.ui), {
    title: `${verb} ${resolved}?\n\n  Allowing grants ${subject}\n  Denying blocks ${subject}${warning}`,
    subject,
    scope: selector,
    narrower: await narrowerScopes(resolved, selector, mode, protectedSelectors),
    durations,
    destinations: profileDestinations(profiles),
  });
  if (answer.decision === "allow-to") return { kind: "profile", profile: answer.destination, selector: answer.scope };
  if (answer.decision === "deny") {
    // A deny always uses the default selector, as the prompt promises; only allows can be narrowed.
    if (answer.duration !== Duration.Once) await addPathRule({ mode, kind: "deny", tier: answer.duration, selector, note: answer.note });
    return { kind: "denied", note: answer.note };
  }
  if (answer.duration === Duration.Once) return { kind: "once", selector: answer.scope };
  await addPathRule({ mode, kind: "allow", tier: answer.duration, selector: answer.scope });
  return { kind: "rule" };
}

type AccessAnswer =
  | { kind: "once"; selector: PathSelector }
  | { kind: "rule" }
  | { kind: "denied"; note: string | undefined }
  | { kind: "profile"; profile: string; selector: PathSelector };

async function narrowerScopes(resolved: string, broad: PathSelector, mode: AccessMode, protectedSelectors: readonly PathSelector[]): Promise<ScopeChoice<PathSelector>[]> {
  const stats = await stat(resolved).catch(() => undefined);
  const entry = stats?.isDirectory() ? EntryKind.Directory : EntryKind.File;
  return narrowerSelectors(resolved, entry, broad).map((candidate) => ({ label: scopeLabel(candidate, mode, protectedSelectors), scope: candidate }));
}

function scopeLabel(selector: PathSelector, mode: AccessMode, protectedSelectors: readonly PathSelector[]): string {
  const warning = coveredProtectedSelectors(selector, protectedSelectors).length > 0 ? " (also covers protected paths)" : "";
  return `${mode} access to ${selectorLabel(selector)}${warning}`;
}

async function grantRootFor(path: string): Promise<string> { const stats = await stat(path).catch(() => undefined); return findRepositoryRoot(stats?.isDirectory() ? path : dirname(path)); }
async function currentDefaults(mode: AccessMode): Promise<ReturnType<typeof defaultAllowed>> {
  const repositoryRoot = await resolveThroughSymlinks(findRepositoryRoot());
  const [memoryRoot, resolvedSkills, agentDirectory, temporaryDirectory] = await Promise.all([
    resolveThroughSymlinks(memoryDirectory()),
    resolvedSkillRoots(repositoryRoot),
    resolveThroughSymlinks(getAgentDir()),
    state.temporaryDirectory === undefined ? undefined : resolveThroughSymlinks(state.temporaryDirectory),
  ]);
  return defaultAllowed(mode, { agentMode: currentAgentMode(), repoRoot: repositoryRoot, memoryDirectory: memoryRoot, skillRoots: resolvedSkills, agentDirectory, temporaryDirectory, homeDirectory: homedir() });
}
// Project skill roots count only while they resolve inside the repository. Global roots also
// allow every entry they hold, since skills are commonly symlinked in from elsewhere.
async function resolvedSkillRoots(repositoryRoot: string): Promise<string[]> {
  const projectRoot = findRepositoryRoot();
  const projectRoots = [join(projectRoot, ".agents", "skills"), join(projectRoot, ".pi", "skills")];
  const globalRoots = [join(getAgentDir(), "skills"), join(homedir(), ".agents", "skills"), join(homedir(), ".claude", "skills")];
  const resolved = new Set<string>();
  for (const root of projectRoots) {
    const resolvedRoot = await resolveThroughSymlinks(root);
    if (contains(repositoryRoot, resolvedRoot)) resolved.add(resolvedRoot);
  }
  for (const root of globalRoots) {
    resolved.add(await resolveThroughSymlinks(root));
    const entries: string[] = await readdir(root).catch(() => []);
    for (const entry of entries) resolved.add(await resolveThroughSymlinks(join(root, entry)));
  }
  return [...resolved];
}
function anchorTarget(target: string, cwd: string): string { return resolve(cwd, expandHome(target)); }
function assertWritablePath(path: string, mode: AccessMode): void { if (mode === "write" && isVcsInternal(path)) throw new Error(`${path} is inside a version control directory. Reading and searching .git and .jj is fine, but writing to them is not.`); }
function deniedError(path: string, mode: AccessMode, note: string | undefined): Error { return new Error(`${path} is denied for ${mode} access by the path rules.${userReason(note)} Do not retry this path and do not route around it with a different tool.${readOnlyRepositoryNotice(mode, currentAgentMode())}`); }

export async function removePathRule(rule: PathRule, store: PathRuleStore = activePathRuleStore()): Promise<void> {
  const { selector } = rule;
  if (rule.tier === "session") { state.sessions[store][rule.mode][rule.kind].delete(selectorKey(selector)); persistSessions(); return; }
  await transaction(RULES_FILE, (always) => { always[store][rule.mode][rule.kind].delete(selectorKey(selector)); });
}
export async function addPathRule(rule: PathRule, store: PathRuleStore = activePathRuleStore()): Promise<void> {
  const { selector } = rule;
  if (rule.tier === "session") {
    const always = (await readStoredRules(RULES_FILE))[store];
    const opposite = rule.kind === "allow" ? "deny" : "allow";
    const oppositeKey = selectorKey(selector);
    if (always[rule.mode][opposite].has(oppositeKey)) await transaction(RULES_FILE, (latest) => { latest[store][rule.mode][opposite].delete(oppositeKey); });
    recordRule(rule, { session: state.sessions[store], always });
    persistSessions();
    return;
  }
  const changed = await transaction(RULES_FILE, (always) => recordRule(rule, { session: state.sessions[store], always: always[store] }));
  if (changed.has("session")) persistSessions();
}
export async function listPathRules(store: PathRuleStore = activePathRuleStore()): Promise<PathRule[]> {
  const always = (await readStoredRules(RULES_FILE))[store];
  const tiers: [RuleTier, RuleSets][] = [["session", state.sessions[store]], ["always", always]];
  return tiers.flatMap(([tier, sets]) =>
    (["read", "write"] as const).flatMap((mode) =>
      (["allow", "deny"] as const).flatMap((kind) =>
        [...sets[mode][kind].keys()].sort().map((key): PathRule => {
          const selector = selectorFromKey(key);
          return kind === "allow" ? { mode, kind, tier, selector } : { mode, kind, tier, selector, note: sets[mode].deny.get(key) };
        }),
      ),
    ),
  );
}
export async function clearPathRules(store: PathRuleStore = activePathRuleStore()): Promise<void> {
  state.sessions[store] = emptyRules();
  persistSessions();
  await transaction(RULES_FILE, (always) => { always[store] = emptyRules(); });
}

export async function captureChildPathPolicy(): Promise<ChildPathPolicy> {
  const ruleStore = activePathRuleStore();
  return { version: 1, session: serializeRules(state.sessions[ruleStore]), readDefaults: await currentDefaults("read"), writeDefaults: await currentDefaults("write"), ruleStore, agentMode: currentAgentMode() };
}

function mergeInheritedSession(session: RuleSets, inherited: ChildPathPolicy | undefined): RuleSets {
  if (inherited === undefined) return session;
  const parent = inheritedRules(inherited);
  return {
    read: { allow: new Set([...parent.read.allow, ...session.read.allow]), deny: new Map([...parent.read.deny, ...session.read.deny]) },
    write: { allow: new Set([...parent.write.allow, ...session.write.allow]), deny: new Map([...parent.write.deny, ...session.write.deny]) },
  };
}

function persistSessions(): void { state.persistSession?.(serializeStoredRules(state.sessions)); }
// An entry in any other format than the current one (version 3) gives empty session rules.
function parseSession(value: unknown): StoredRules { try { return isRecord(value) ? parseStoredRules(value) : emptyStoredRules(); } catch { return emptyStoredRules(); } }

const GLOB_COMPONENT = /[*?[\]{}]|\([^)]*[?+*@!]\)|\([^)]*\)/;

export async function normalizePathSelector(input: string, cwd: string): Promise<PathSelector> {
  const expanded = expandHome(input);
  const absolute = expanded.startsWith(sep) ? expanded : `${cwd}${sep}${expanded}`;
  const components = absolute.split(sep);
  const globIndex = components.findIndex((component) => GLOB_COMPONENT.test(component));
  if (globIndex < 0) return exact(await resolveThroughSymlinks(absolute));
  if (components.slice(globIndex + 1).some((component) => component === "." || component === "..")) throw new Error("Path patterns cannot contain . or .. after a glob component");
  const prefix = components.slice(0, globIndex).join(sep) || sep;
  const base = await resolveThroughSymlinks(prefix);
  const pattern = components.slice(globIndex).join(sep);
  if (pattern === `**`) return tree(base);
  return glob(base, pattern);
}
