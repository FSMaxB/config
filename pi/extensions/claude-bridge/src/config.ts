import type { SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve, sep } from "path";
import { debug } from "./debug.js";

export type BridgeEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

const VALID_EFFORT_LEVELS = new Set<BridgeEffortLevel>(["low", "medium", "high", "xhigh", "max"]);

export interface Config {
	enabled?: boolean;
	/** Low-level Claude Agent SDK plumbing. Most users won't need these. */
	provider?: {
		appendSystemPrompt?: boolean;
		/** Enable Claude Code fast mode for bridge requests. */
		fastMode?: boolean;
		/** Force this Claude Code effort level for every bridge request. */
		forceEffort?: BridgeEffortLevel;
		/** Per-model Claude Code effort overrides keyed by model id (e.g. claude-opus-4-8). */
		modelEffortOverrides?: Record<string, BridgeEffortLevel>;
		/**
		 * Verbatim override for the child's filesystem setting sources.
		 * The default setting sources are ["user", "project"] unless the
		 * system prompt is appended.
		 */
		settingSources?: SettingSource[];
		pathToClaudeCodeExecutable?: string;
	};
	/** Extra Pi context forwarded to Claude Code on top of AGENTS.md + skills. */
	promptContext?: {
		includeAppendSystemPromptMd?: boolean;

	};
}

type SettingsRecord = Record<string, unknown>;

function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return join(homedir(), input.slice(2));
	return input;
}

/** Root-anchored as `crates/core/src/harness/pi.rs::pi_root_is_absolute_for`
 * means it, which `isAbsolute` is not: it calls a driveless `\root` absolute
 * where the renderer does not, putting the two on different roots. Hoisted, so
 * a circular import cannot reach it inside a temporal dead zone. */
function rootAnchored(path: string, windows: boolean): boolean { return windows ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(path) : path.startsWith("/"); }

/**
 * The Pi agent config dir: `PI_CODING_AGENT_DIR` when it names a root-anchored
 * path, else `~/.pi/agent`. Every bridge default routes through this function
 * so a host app that owns the agent dir owns
 * those paths too.
 */
export function piUserDir(): string {
	const override = expandHome(process.env.PI_CODING_AGENT_DIR?.trim() || "");
	return resolve(rootAnchored(override, process.platform === "win32") ? override : expandHome("~/.pi/agent"));
}

/**
 * Isolated mode (`CLAUDE_BRIDGE_ISOLATED=1`) : a host app embedding the bridge
 * declares that nothing outside its explicitly configured dirs may be read.
 * Disables every cwd/home discovery fallback — all AGENTS.md discovery,
 * project `.pi/claude-bridge.json`,
 * project APPEND_SYSTEM.md, and the `$PATH` claude executable search. Bridge
 * configuration comes only from `piUserDir()/claude-bridge.json` and any
 * explicitly configured executable path.
 * Default (unset) behavior for normal pi CLI users is unchanged.
 */
export function isolatedFromEnv(): boolean {
	const v = (process.env.CLAUDE_BRIDGE_ISOLATED ?? "").trim().toLowerCase();
	return v === "1" || v === "true" || v === "yes" || v === "on";
}

function asRecord(value: unknown): SettingsRecord | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as SettingsRecord : undefined;
}

function projectSettingsPath(cwd: string): string {
	let current = resolve(cwd);
	while (true) {
		const candidate = join(current, ".pi", "settings.json");
		if (existsSync(candidate)) return candidate;
		if (existsSync(join(current, ".pi")) || existsSync(join(current, ".git"))) return candidate;
		const parent = dirname(current);
		if (parent === current) return join(resolve(cwd), ".pi", "settings.json");
		current = parent;
	}
}

const PROJECT_TRUST_SYMBOL = Symbol.for("kendex.pi.project-trust");

interface ProjectTrustRegistry {
	projectSettings?: Map<string, boolean>;
}

function projectTrustRegistry(): ProjectTrustRegistry {
	const host = globalThis as unknown as Record<PropertyKey, ProjectTrustRegistry | undefined>;
	const existing = host[PROJECT_TRUST_SYMBOL];
	if (existing) return existing;
	const created: ProjectTrustRegistry = {};
	host[PROJECT_TRUST_SYMBOL] = created;
	return created;
}

export function recordProjectTrust(ctx: { cwd?: string; isProjectTrusted?: () => boolean }): void {
	if (!ctx.cwd) return;
	// Isolated mode never reads project config, so recording trust would only
	// run the cwd-ancestor `.pi/settings.json` walk (a filesystem probe outside
	// the host-owned dirs) for a result nothing consumes. Skip it entirely.
	if (isolatedFromEnv()) return;
	let trusted = true;
	try {
		trusted = ctx.isProjectTrusted?.() === true;
	} catch {
		trusted = false;
	}
	const registry = projectTrustRegistry();
	if (!registry.projectSettings) registry.projectSettings = new Map();
	registry.projectSettings.set(projectSettingsPath(ctx.cwd), trusted);
}

function projectSettingsTrusted(settingsPath: string): boolean {
	return projectTrustRegistry().projectSettings?.get(settingsPath) === true;
}


export function tryParseJson(path: string): Partial<Config> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		// Malformed optional config should not write raw terminal diagnostics;
		// stdout/stderr output can corrupt active Pi TUI widgets. The debug log is
		// the one place a silently-ignored file explains itself.
		debug(`config: ignoring malformed ${path}:`, error instanceof Error ? error.message : String(error));
		return {};
	}
}

function boolFrom(raw: SettingsRecord, key: string): boolean | undefined {
	return typeof raw[key] === "boolean" ? raw[key] as boolean : undefined;
}

function stringFrom(raw: SettingsRecord, key: string): string | undefined {
	const value = raw[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function normalizeEffortLevel(value: unknown): BridgeEffortLevel | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "" || normalized === "none" || normalized === "auto" || normalized === "default") return undefined;
	return VALID_EFFORT_LEVELS.has(normalized as BridgeEffortLevel) ? normalized as BridgeEffortLevel : undefined;
}

export function normalizeModelEffortOverrides(value: unknown): Record<string, BridgeEffortLevel> | undefined {
	let source: unknown = value;
	if (typeof source === "string") {
		const trimmed = source.trim();
		if (!trimmed || trimmed === "{}") return undefined;
		try {
			source = JSON.parse(trimmed);
		} catch {
			return undefined;
		}
	}
	const record = asRecord(source);
	if (!record) return undefined;

	const out: Record<string, BridgeEffortLevel> = {};
	for (const [modelId, rawEffort] of Object.entries(record)) {
		const key = modelId.trim();
		const effort = normalizeEffortLevel(rawEffort);
		if (key && effort) out[key] = effort;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeProviderConfig(provider: Config["provider"] | undefined): Config["provider"] {
	if (!provider) return {};
	const raw = provider as SettingsRecord;
	const out: Config["provider"] = {
		...(boolFrom(raw, "appendSystemPrompt") !== undefined ? { appendSystemPrompt: boolFrom(raw, "appendSystemPrompt") } : {}),
		...(boolFrom(raw, "fastMode") !== undefined ? { fastMode: boolFrom(raw, "fastMode") } : {}),
		...(stringFrom(raw, "pathToClaudeCodeExecutable") ? { pathToClaudeCodeExecutable: stringFrom(raw, "pathToClaudeCodeExecutable") } : {}),
		...(Array.isArray(raw.settingSources) && raw.settingSources.every((source) => source === "user" || source === "project" || source === "local")
			? { settingSources: raw.settingSources as SettingSource[] } : {}),
	};
	const forceEffort = normalizeEffortLevel(raw.forceEffort);
	if (forceEffort) out.forceEffort = forceEffort;
	else delete out.forceEffort;
	const modelEffortOverrides = normalizeModelEffortOverrides(raw.modelEffortOverrides);
	if (modelEffortOverrides) out.modelEffortOverrides = modelEffortOverrides;
	else delete out.modelEffortOverrides;
	return out;
}

export function loadConfig(cwd: string): Config {
	const user = fileConfig(join(piUserDir(), "claude-bridge.json"));
	const projectSettings = isolatedFromEnv() ? undefined : projectSettingsPath(cwd);
	const project = projectSettings && projectSettingsTrusted(projectSettings)
		? fileConfig(join(dirname(projectSettings), "claude-bridge.json")) : {};
	return {
		enabled: project.enabled ?? user.enabled ?? true,
		provider: normalizeProviderConfig({ ...user.provider, ...project.provider }),
		promptContext: { ...user.promptContext, ...project.promptContext },
	};
}

function fileConfig(path: string): Partial<Config> {
	const raw = asRecord(tryParseJson(path)) ?? {};
	const rawProvider = asRecord(raw.provider) ?? {};
	const provider = {
		...(boolFrom(rawProvider, "appendSystemPrompt") !== undefined ? { appendSystemPrompt: boolFrom(rawProvider, "appendSystemPrompt") } : {}),
		...(boolFrom(rawProvider, "fastMode") !== undefined ? { fastMode: boolFrom(rawProvider, "fastMode") } : {}),
		...(stringFrom(rawProvider, "pathToClaudeCodeExecutable") ? { pathToClaudeCodeExecutable: stringFrom(rawProvider, "pathToClaudeCodeExecutable") } : {}),
		...(Array.isArray(rawProvider.settingSources) && rawProvider.settingSources.every((source) => source === "user" || source === "project" || source === "local")
			? { settingSources: rawProvider.settingSources as SettingSource[] } : {}),
		...(Object.hasOwn(rawProvider, "forceEffort") ? { forceEffort: rawProvider.forceEffort } : {}),
		...(Object.hasOwn(rawProvider, "modelEffortOverrides") ? { modelEffortOverrides: rawProvider.modelEffortOverrides } : {}),
	} as Config["provider"];
	const prompt = asRecord(raw.promptContext) ?? {};
	const promptContext: Config["promptContext"] = {};

	const includeAppendSystemPromptMd = boolFrom(prompt, "includeAppendSystemPromptMd");
	if (includeAppendSystemPromptMd !== undefined) promptContext.includeAppendSystemPromptMd = includeAppendSystemPromptMd;

	return {
		...(boolFrom(raw, "enabled") !== undefined ? { enabled: boolFrom(raw, "enabled") } : {}),
		...(Object.keys(provider ?? {}).length ? { provider } : {}),
		...(Object.keys(promptContext).length ? { promptContext } : {}),
	};
}

/** Home-relative when possible — for user-facing path mentions (what to edit,
 *  what to paste into an issue) where an absolute path would leak the username. */
export function displayPath(path: string): string {
	const home = homedir();
	return home && path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

