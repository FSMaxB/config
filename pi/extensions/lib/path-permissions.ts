import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { covers, defaultAllowed, emptyRules, evaluate, exact, glob, matchesRule, parseRules, planModeNotice, recordRule, selectorFromKey, selectorKey, selectorLabel, serializeRules, tree, type AccessMode, type PathSelector, type PathRule, type RuleSets, type RuleTier, type SerializedRules, type Verdict } from "./path-permission-rules.ts";
import { expandHome } from "./path-resolution.ts";
import { readStoredRules, transaction } from "./path-rule-store.ts";
import { contains, findRepoRoot, isVcsInternal, memoryDirectory, resolveThroughSymlinks } from "./repo.ts";
import { latestCustomData } from "./session-entries.ts";
import { serialize } from "./ui-queue.ts";
import { inheritedRules, parseChildPathPolicy, type ChildPathPolicy } from "./path-permission-snapshot.ts";
import { ALLOW_ALWAYS, ALLOW_ONCE, ALLOW_SESSION, DENY_ALWAYS, DENY_ONCE, DENY_SESSION } from "./permission-choices.ts";
export { ALLOW_ALWAYS, ALLOW_ONCE, ALLOW_SESSION, DENY_ALWAYS, DENY_ONCE, DENY_SESSION } from "./permission-choices.ts";
export const PATH_RULES_ENTRY_TYPE = "path-permissions";
const RULES_FILE = join(getAgentDir(), "path-permissions.json");
interface SharedState { session: RuleSets; planMode: boolean; temporaryDirectory?: string; inherited?: ChildPathPolicy | null; persistSession?: (snapshot: SerializedRules) => void }
const globalState = globalThis as { piPathPermissions?: SharedState };
const state = (globalState.piPathPermissions ??= { session: emptyRules(), planMode: false, inherited: parseChildPathPolicy(process.env.PI_SUBAGENT_PATH_POLICY) });
export function setPlanModeEnabled(enabled: boolean): void { state.planMode = enabled; }
export function isPlanModeEnabled(): boolean { return state.planMode; }
export function setSessionTemporaryDirectory(path: string): void { state.temporaryDirectory = path; }
export function initPathPermissions(pi: ExtensionAPI): void { state.persistSession = (snapshot) => pi.appendEntry(PATH_RULES_ENTRY_TYPE, snapshot); }
export function restoreSessionPathRules(sessionManager: { getEntries(): readonly unknown[] }): void {
  state.session = parseSession(latestCustomData(sessionManager, PATH_RULES_ENTRY_TYPE));
}

export const PathResolution = { Follow: "follow", PreserveFinalSymlink: "preserve-final-symlink" } as const;
export type PathResolution = (typeof PathResolution)[keyof typeof PathResolution];
export type GatedScope = "root" | "children" | "recursive";

export function gatedTool(definition: ToolDefinition<any, any, any>, mode: AccessMode, resolution: PathResolution = PathResolution.Follow, scope: GatedScope = "root"): ToolDefinition<any, any, any> {
  return { ...definition, async execute(toolCallId, params, signal, onUpdate, context) {
    const { path } = params as { path?: string };
    const authorization = await authorizeRoot(path ?? context.cwd, mode, context, resolution);
    if (scope !== "root") {
      const { preflightPath } = await import("./path-preflight.ts");
      await preflightPath(authorization, scope, signal);
    }
    return await definition.execute(toolCallId, { ...(params as Record<string, unknown>), path: authorization.operationPath }, signal, onUpdate, context);
  } };
}

export interface PathAuthorization { operationPath: string; checkedPaths: string[]; mode: AccessMode; context: ExtensionContext; defaults: ReturnType<typeof defaultAllowed>; session: RuleSets; always: RuleSets; protected: PathSelector[]; }
export async function authorizeRoot(target: string, mode: AccessMode, context: ExtensionContext, resolution: PathResolution = PathResolution.Follow): Promise<PathAuthorization> {
  if (state.inherited === null) throw new Error("The inherited child path policy is invalid; path tools are disabled.");
  const anchored = anchorTarget(target, context.cwd);
  const resolved = await resolveThroughSymlinks(anchored);
  const operationPath = resolution === PathResolution.PreserveFinalSymlink ? join(await resolveThroughSymlinks(dirname(anchored)), basename(anchored)) : resolved;
  const checkedPaths = [...new Set([resolved, operationPath])];
  for (const path of checkedPaths) assertWritablePath(path, mode);
  const layers = await effectiveLayers(mode);
  for (const path of checkedPaths) if (evaluate(path, mode, layers) === "deny") throw deniedError(path, mode);
  for (const path of checkedPaths) await ensureAllowed(path, mode, context, layers);
  const { defaults, session, always, protected: protectedSelectors } = layers;
  return { operationPath, checkedPaths, mode, context, defaults, session, always, protected: protectedSelectors };
}

export interface ModePolicy { allow: PathSelector[]; deny: PathSelector[]; protected: PathSelector[] }
export interface EffectivePolicy { read: ModePolicy; write: ModePolicy }

// The merged view per mode, for enforcement outside this process (the bash sandbox).
export async function currentPolicy(): Promise<EffectivePolicy> {
  if (state.inherited === null) throw new Error("The inherited child path policy is invalid; the sandbox cannot be configured.");
  return { read: await modePolicy("read"), write: await modePolicy("write") };
}

const POST_FAILURE_CHOICES = [ALLOW_SESSION, ALLOW_ALWAYS, DENY_ONCE, DENY_SESSION, DENY_ALWAYS];

// Used by the sandbox after a command was denied: the command already failed, so "allow once" is meaningless.
export async function grantPathAccess(path: string, mode: AccessMode, context: ExtensionContext): Promise<"allowed" | "denied"> {
  const resolved = await resolveThroughSymlinks(path);
  const verdict = async () => evaluate(resolved, mode, await effectiveLayers(mode));
  const settled = (current: Verdict) => current === "prompt" ? undefined : current === "allow" ? "allowed" : "denied";
  const immediate = settled(await verdict());
  if (immediate) return immediate;
  return await serialize(async () => {
    const latest = settled(await verdict());
    if (latest) return latest;
    const { protected: protectedSelectors } = await effectiveLayers(mode);
    try { await requestAccess(resolved, mode, context, protectedSelectors, POST_FAILURE_CHOICES); return "allowed"; }
    catch { return "denied"; }
  });
}

async function modePolicy(mode: AccessMode): Promise<ModePolicy> {
  const { defaults, always, session, protected: protectedSelectors } = await effectiveLayers(mode);
  const explicitAllow = [...always[mode].allow, ...session[mode].allow].map(selectorFromKey);
  const deny = [...always[mode].deny, ...session[mode].deny].map(selectorFromKey);
  const uncovered = protectedSelectors.filter((target) => !explicitAllow.some((grant) => covers(grant, target)));
  return { allow: [...defaults, ...explicitAllow], deny, protected: uncovered };
}

async function effectiveLayers(mode: AccessMode): Promise<{ defaults: PathSelector[]; always: RuleSets; session: RuleSets; protected: PathSelector[] }> {
  const always = await readStoredRules(RULES_FILE);
  const session = mergeInheritedSession(state.session, state.inherited);
  const inheritedDefaults = state.inherited ? (mode === "read" ? state.inherited.readDefaults : state.inherited.writeDefaults) : [];
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
  const verdict = () => evaluate(path, mode, layers);
  if (verdict() === "deny") throw deniedError(path, mode);
  if (verdict() === "allow") return;
  await serialize(async () => { if (verdict() === "deny") throw deniedError(path, mode); if (verdict() === "allow") return; await requestAccess(path, mode, context, layers.protected); });
}

async function requestAccess(resolved: string, mode: AccessMode, context: ExtensionContext, protectedSelectors: PathSelector[] = [], choices: string[] = [ALLOW_ONCE, ALLOW_SESSION, ALLOW_ALWAYS, DENY_ONCE, DENY_SESSION, DENY_ALWAYS]): Promise<void> {
  if (!context.hasUI) throw new Error(`${resolved} is not covered by the ${mode} path rules and there is no interactive UI to ask. Stay inside the repository.${planModeNotice(mode, state.planMode)}`);
  // A protected path is granted as its own protected root, so approving one extension file does not open the whole repository.
  const protectedMatch = protectedSelectors.find((candidate) => matchesRule(resolved, candidate));
  const selector = protectedMatch ?? tree(await grantRootFor(resolved));
  const label = selectorLabel(selector), verb = mode === "read" ? "Read" : "Write";
  const choice = await context.ui.select(`${verb} ${resolved}?\n\n  Allowing grants ${mode} access to ${label}\n  Denying blocks ${mode} access to ${label}`, choices);
  if (choice === ALLOW_ONCE) return;
  if (choice === ALLOW_SESSION) { await addPathRule({ mode, kind: "allow", tier: "session", selector }); return; }
  if (choice === ALLOW_ALWAYS) { await addPathRule({ mode, kind: "allow", tier: "always", selector }); return; }
  if (choice === DENY_SESSION) { await addPathRule({ mode, kind: "deny", tier: "session", selector }); throw deniedError(resolved, mode); }
  if (choice === DENY_ALWAYS) { await addPathRule({ mode, kind: "deny", tier: "always", selector }); throw deniedError(resolved, mode); }
  throw deniedError(resolved, mode);
}

async function grantRootFor(path: string): Promise<string> { const stats = await stat(path).catch(() => undefined); return findRepoRoot(stats?.isDirectory() ? path : dirname(path)); }
async function currentDefaults(mode: AccessMode): Promise<ReturnType<typeof defaultAllowed>> {
  const repoRoot = await resolveThroughSymlinks(findRepoRoot());
  const [memoryRoot, resolvedSkills, agentDirectory, temporaryDirectory] = await Promise.all([
    resolveThroughSymlinks(memoryDirectory()),
    resolvedSkillRoots(repoRoot),
    resolveThroughSymlinks(getAgentDir()),
    state.temporaryDirectory === undefined ? undefined : resolveThroughSymlinks(state.temporaryDirectory),
  ]);
  return defaultAllowed(mode, { planMode: state.planMode, repoRoot, memoryDirectory: memoryRoot, skillRoots: resolvedSkills, agentDirectory, temporaryDirectory });
}
// Project skill roots count only while they resolve inside the repository. Global roots also
// allow every entry they hold, since skills are commonly symlinked in from elsewhere.
async function resolvedSkillRoots(repoRoot: string): Promise<string[]> {
  const projectRoot = findRepoRoot();
  const projectRoots = [join(projectRoot, ".agents", "skills"), join(projectRoot, ".pi", "skills")];
  const globalRoots = [join(getAgentDir(), "skills"), join(homedir(), ".agents", "skills"), join(homedir(), ".claude", "skills")];
  const resolved = new Set<string>();
  for (const root of projectRoots) {
    const resolvedRoot = await resolveThroughSymlinks(root);
    if (contains(repoRoot, resolvedRoot)) resolved.add(resolvedRoot);
  }
  for (const root of globalRoots) {
    resolved.add(await resolveThroughSymlinks(root));
    for (const entry of await readdir(root).catch(() => [] as string[])) resolved.add(await resolveThroughSymlinks(join(root, entry)));
  }
  return [...resolved];
}
function anchorTarget(target: string, cwd: string): string { const expanded = expandHome(target); return isAbsolute(expanded) ? expanded : resolve(cwd, expanded); }
function assertWritablePath(path: string, mode: AccessMode): void { if (mode === "write" && isVcsInternal(path)) throw new Error(`${path} is inside a version control directory. Reading and searching .git and .jj is fine, but writing to them is not.`); }
function deniedError(path: string, mode: AccessMode): Error { return new Error(`${path} is denied for ${mode} access by the path rules. Do not retry this path and do not route around it with a different tool.${planModeNotice(mode, state.planMode)}`); }

export async function removePathRule(rule: PathRule): Promise<void> { const { selector } = rule; if (rule.tier === "session") { state.session[rule.mode][rule.kind].delete(selectorKey(selector)); state.persistSession?.(serializeRules(state.session)); return; } await transaction(RULES_FILE, (always) => { always[rule.mode][rule.kind].delete(selectorKey(selector)); }); }
export async function addPathRule(rule: PathRule): Promise<void> {
  const { selector } = rule;
  if (rule.tier === "session") {
    const always = await readStoredRules(RULES_FILE);
    const opposite = rule.kind === "allow" ? "deny" : "allow";
    const oppositeKey = selectorKey(selector);
    if (always[rule.mode][opposite].has(oppositeKey)) await transaction(RULES_FILE, (latest) => { latest[rule.mode][opposite].delete(oppositeKey); });
    recordRule(rule, { session: state.session, always });
    state.persistSession?.(serializeRules(state.session));
    return;
  }
  await transaction(RULES_FILE, (always) => { recordRule(rule, { session: emptyRules(), always }); });
}
export async function listPathRules(): Promise<PathRule[]> {
  const always = await readStoredRules(RULES_FILE);
  const tiers: [RuleTier, RuleSets][] = [["session", state.session], ["always", always]];
  return tiers.flatMap(([tier, sets]) =>
    (["read", "write"] as const).flatMap((mode) =>
      (["allow", "deny"] as const).flatMap((kind) =>
        [...sets[mode][kind]].sort().map((key) => ({ mode, kind, tier, selector: selectorFromKey(key) })),
      ),
    ),
  );
}
export async function clearPathRules(): Promise<void> { state.session = emptyRules(); state.persistSession?.(serializeRules(state.session)); await transaction(RULES_FILE, (always) => { always.read.allow.clear(); always.read.deny.clear(); always.write.allow.clear(); always.write.deny.clear(); }); }

function parseSession(value: unknown): RuleSets { try { return value && typeof value === "object" ? (parseRules(value) as RuleSets) : emptyRules(); } catch { return emptyRules(); } }
export async function captureChildPathPolicy(): Promise<ChildPathPolicy> {
  return { version: 1, session: serializeRules(state.session), readDefaults: await currentDefaults("read"), writeDefaults: await currentDefaults("write") };
}

function mergeInheritedSession(session: RuleSets, inherited: ChildPathPolicy | null | undefined): RuleSets {
  if (!inherited) return session;
  const parent = inheritedRules(inherited);
  return {
    read: { allow: new Set([...parent.read.allow, ...session.read.allow]), deny: new Set([...parent.read.deny, ...session.read.deny]) },
    write: { allow: new Set([...parent.write.allow, ...session.write.allow]), deny: new Set([...parent.write.deny, ...session.write.deny]) },
  };
}

const GLOB_COMPONENT = /[*?\[\]{}]|\([^)]*[?+*@!]\)|\([^)]*\)/;

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
