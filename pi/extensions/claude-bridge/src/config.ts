import type { SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { debug } from "./debug.js";
import { ancestorDirectories } from "../../lib/repo.ts";
import { isRecord } from "../../lib/untyped.ts";

export type BridgeEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

const VALID_EFFORT_LEVELS: readonly BridgeEffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
const SETTING_SOURCES: readonly SettingSource[] = ["user", "project", "local"];

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

// One claude-bridge.json file. Its provider settings stay raw until the files are merged.
interface FileConfig {
	enabled?: boolean;
	provider?: SettingsRecord;
	promptContext?: Config["promptContext"];
}

function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return join(homedir(), input.slice(2));
	return input;
}

/** Root-anchored as `crates/core/src/harness/pi.rs::pi_root_is_absolute_for`
 * means it, which `isAbsolute` is not: it calls a driveless `\root` absolute
 * where the renderer does not, putting the two on different roots. Hoisted, so
 * a circular import cannot reach it inside a temporal dead zone. */
function rootAnchored(path: string, platform: "windows" | "posix"): boolean { return platform === "windows" ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(path) : path.startsWith("/"); }

/**
 * The Pi agent config dir: `PI_CODING_AGENT_DIR` when it names a root-anchored
 * path, else `~/.pi/agent`. Every bridge default routes through this function
 * so a host app that owns the agent dir owns
 * those paths too.
 */
export function piUserDirectory(): string {
	const override = expandHome(process.env.PI_CODING_AGENT_DIR?.trim() || "");
	return resolve(rootAnchored(override, process.platform === "win32" ? "windows" : "posix") ? override : expandHome("~/.pi/agent"));
}

/**
 * Isolated mode (`CLAUDE_BRIDGE_ISOLATED=1`) : a host app embedding the bridge
 * declares that nothing outside its explicitly configured dirs may be read.
 * Disables every cwd/home discovery fallback — all AGENTS.md discovery,
 * project `.pi/claude-bridge.json` and project APPEND_SYSTEM.md. Bridge
 * configuration comes only from `piUserDirectory()/claude-bridge.json`.
 */
export function isolatedFromEnvironment(): boolean {
	const v = (process.env.CLAUDE_BRIDGE_ISOLATED ?? "").trim().toLowerCase();
	return v === "1" || v === "true" || v === "yes" || v === "on";
}

function asRecord(value: unknown): SettingsRecord | undefined {
	return isRecord(value) ? value : undefined;
}

function isSettingSources(value: unknown): value is SettingSource[] {
	return Array.isArray(value) && value.every((source) => SETTING_SOURCES.some((known) => known === source));
}

function projectSettingsPath(cwd: string): string {
	for (const directory of ancestorDirectories(cwd)) {
		const candidate = join(directory, ".pi", "settings.json");
		if (existsSync(candidate)) return candidate;
		if (existsSync(join(directory, ".pi")) || existsSync(join(directory, ".git"))) return candidate;
	}
	return join(resolve(cwd), ".pi", "settings.json");
}

const PROJECT_TRUST_SYMBOL = Symbol.for("kendex.pi.project-trust");

interface ProjectTrustRegistry {
	projectSettings?: Map<string, boolean>;
}

// Every copy of this module in the process shares the registry; only this function creates it.
function projectTrustRegistry(): ProjectTrustRegistry {
	const host = globalThis as Record<symbol, ProjectTrustRegistry | undefined>;
	const existing = host[PROJECT_TRUST_SYMBOL];
	if (existing) return existing;
	const created: ProjectTrustRegistry = {};
	host[PROJECT_TRUST_SYMBOL] = created;
	return created;
}

export function recordProjectTrust(context: { cwd?: string; isProjectTrusted?: () => boolean }): void {
	if (!context.cwd) return;
	// Isolated mode never reads project config, so recording trust would only
	// run the cwd-ancestor `.pi/settings.json` walk (a filesystem probe outside
	// the host-owned dirs) for a result nothing consumes. Skip it entirely.
	if (isolatedFromEnvironment()) return;
	let trusted: boolean;
	try {
		trusted = context.isProjectTrusted?.() === true;
	} catch {
		trusted = false;
	}
	const registry = projectTrustRegistry();
	if (!registry.projectSettings) registry.projectSettings = new Map();
	registry.projectSettings.set(projectSettingsPath(context.cwd), trusted);
}

function projectSettingsTrusted(settingsPath: string): boolean {
	return projectTrustRegistry().projectSettings?.get(settingsPath) === true;
}


export function tryParseJson(path: string): unknown {
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		return parsed;
	} catch (error) {
		// Malformed optional config should not write raw terminal diagnostics;
		// stdout/stderr output can corrupt active Pi TUI widgets. The debug log is
		// the one place a silently-ignored file explains itself.
		debug(`config: ignoring malformed ${path}:`, error instanceof Error ? error.message : String(error));
		return {};
	}
}

function boolFrom(raw: SettingsRecord, key: string): boolean | undefined {
	const value = raw[key];
	return typeof value === "boolean" ? value : undefined;
}

function stringFrom(raw: SettingsRecord, key: string): string | undefined {
	const value = raw[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function normalizeEffortLevel(value: unknown): BridgeEffortLevel | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "" || normalized === "none" || normalized === "auto" || normalized === "default") return undefined;
	return VALID_EFFORT_LEVELS.find((level) => level === normalized);
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

function normalizeProviderConfig(raw: SettingsRecord): Config["provider"] {
	const out: Config["provider"] = {
		...(boolFrom(raw, "appendSystemPrompt") !== undefined ? { appendSystemPrompt: boolFrom(raw, "appendSystemPrompt") } : {}),
		...(boolFrom(raw, "fastMode") !== undefined ? { fastMode: boolFrom(raw, "fastMode") } : {}),
		...(stringFrom(raw, "pathToClaudeCodeExecutable") ? { pathToClaudeCodeExecutable: stringFrom(raw, "pathToClaudeCodeExecutable") } : {}),
		...(isSettingSources(raw.settingSources) ? { settingSources: raw.settingSources } : {}),
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
	const user = fileConfig(join(piUserDirectory(), "claude-bridge.json"));
	const projectSettings = isolatedFromEnvironment() ? undefined : projectSettingsPath(cwd);
	const project = projectSettings && projectSettingsTrusted(projectSettings)
		? fileConfig(join(dirname(projectSettings), "claude-bridge.json")) : {};
	return {
		enabled: project.enabled ?? user.enabled ?? true,
		provider: normalizeProviderConfig({ ...user.provider, ...project.provider }),
		promptContext: { ...user.promptContext, ...project.promptContext },
	};
}

function fileConfig(path: string): FileConfig {
	const raw = asRecord(tryParseJson(path)) ?? {};
	const rawProvider = asRecord(raw.provider) ?? {};
	const provider: SettingsRecord = {
		...(boolFrom(rawProvider, "appendSystemPrompt") !== undefined ? { appendSystemPrompt: boolFrom(rawProvider, "appendSystemPrompt") } : {}),
		...(boolFrom(rawProvider, "fastMode") !== undefined ? { fastMode: boolFrom(rawProvider, "fastMode") } : {}),
		...(stringFrom(rawProvider, "pathToClaudeCodeExecutable") ? { pathToClaudeCodeExecutable: stringFrom(rawProvider, "pathToClaudeCodeExecutable") } : {}),
		...(isSettingSources(rawProvider.settingSources) ? { settingSources: rawProvider.settingSources } : {}),
		...(Object.hasOwn(rawProvider, "forceEffort") ? { forceEffort: rawProvider.forceEffort } : {}),
		...(Object.hasOwn(rawProvider, "modelEffortOverrides") ? { modelEffortOverrides: rawProvider.modelEffortOverrides } : {}),
	};
	const prompt = asRecord(raw.promptContext) ?? {};
	const promptContext: Config["promptContext"] = {};

	const includeAppendSystemPromptMd = boolFrom(prompt, "includeAppendSystemPromptMd");
	if (includeAppendSystemPromptMd !== undefined) promptContext.includeAppendSystemPromptMd = includeAppendSystemPromptMd;

	return {
		...(boolFrom(raw, "enabled") !== undefined ? { enabled: boolFrom(raw, "enabled") } : {}),
		...(Object.keys(provider).length ? { provider } : {}),
		...(Object.keys(promptContext).length ? { promptContext } : {}),
	};
}

/** Home-relative when possible — for user-facing path mentions (what to edit,
 *  what to paste into an issue) where an absolute path would leak the username. */
export function displayPath(path: string): string {
	const home = homedir();
	return home && path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

