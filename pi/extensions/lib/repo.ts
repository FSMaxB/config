import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getCurrentPlanPath } from "./plan-file.ts";
import { serialize } from "./ui-queue.ts";

export type AccessMode = "read" | "write";

export interface VcsInfo {
	kind: "jj" | "git" | "none";
	root: string;
	colocated: boolean;
}

const CONFIG_FILE = join(getAgentDir(), "repo-scope.json");

const ALLOW_ONCE = "Allow once";
const ALLOW_SESSION = "Allow in session";
const ALLOW_ALWAYS = "Allow always";
const DENY = "Deny";

const sessionRoots: Record<AccessMode, Set<string>> = { read: new Set(), write: new Set() };
const configuredRoots: Record<AccessMode, Set<string>> = { read: new Set(), write: new Set() };
let configLoaded = false;

export function findRepoRoot(from: string = process.cwd()): string {
	return findVcsRoot(from) ?? resolve(from);
}

export function detectVcs(from: string = process.cwd()): VcsInfo {
	const root = findVcsRoot(from);
	if (!root) return { kind: "none", root: resolve(from), colocated: false };

	const jj = existsSync(join(root, ".jj"));
	const git = existsSync(join(root, ".git"));
	return { kind: jj ? "jj" : "git", root, colocated: jj && git };
}

// Returns the resolved absolute path, or throws when the path is off limits. Symlinks are
// followed first, so a link inside the repo cannot be used to reach outside it.
export async function ensureAccessible(target: string, mode: AccessMode, ctx: ExtensionContext): Promise<string> {
	const resolved = await resolveThroughSymlinks(target);

	if (mode === "write" && isVcsInternal(resolved)) {
		throw new Error(
			`${resolved} is inside a version control directory. Reading and searching .git and .jj is fine, ` +
				"but writing to them is not. Use the vcs_* tools to inspect history, or jj/git via bash to change it.",
		);
	}

	await loadConfig();
	if (await isAllowed(resolved, mode)) return resolved;

	return await serialize(async () => {
		// A prompt queued ahead of this one may already have granted the enclosing root.
		if (await isAllowed(resolved, mode)) return resolved;
		return await requestAccess(resolved, mode, ctx);
	});
}

export function isVcsInternal(path: string): boolean {
	return path.split(sep).some((component) => component === ".git" || component === ".jj");
}

function findVcsRoot(from: string): string | undefined {
	let current = resolve(from);
	while (true) {
		if (existsSync(join(current, ".jj")) || existsSync(join(current, ".git"))) return current;

		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

// realpath() fails on paths that do not exist yet, which is the normal case for a new file,
// so resolve the deepest existing ancestor and re-attach the missing tail.
async function resolveThroughSymlinks(target: string): Promise<string> {
	const absolute = resolve(expandHome(target));
	const missing: string[] = [];
	let existing = absolute;

	while (true) {
		try {
			return join(await realpath(existing), ...missing);
		} catch {
			const parent = dirname(existing);
			if (parent === existing) return absolute;
			missing.unshift(basename(existing));
			existing = parent;
		}
	}
}

async function isAllowed(resolved: string, mode: AccessMode): Promise<boolean> {
	const repoRoot = await resolveThroughSymlinks(findRepoRoot());
	if (contains(repoRoot, resolved)) return true;

	for (const root of allowedRoots(mode)) {
		if (contains(root, resolved)) return true;
	}
	return false;
}

function* allowedRoots(mode: AccessMode): Generator<string> {
	const memory = memoryDirectory();
	if (memory) yield memory;

	const plan = getCurrentPlanPath();
	if (plan) yield plan;

	if (mode === "read") {
		yield join(homedir(), ".crit");
		yield join(getAgentDir(), "plans");
		// Skills are meant to be loaded on demand, so the global skill roots are readable.
		// Project-level .agents/skills and .pi/skills need no entry, being inside the repo.
		yield join(getAgentDir(), "skills");
		yield join(homedir(), ".agents", "skills");
		yield join(homedir(), ".claude", "skills");
	}

	yield* configuredRoots[mode];
	yield* sessionRoots[mode];
}

// Claude Code derives this directory from the cwd. If that scheme ever changes the guard
// just falls through to the prompt, so it is not worth probing for.
function memoryDirectory(): string | undefined {
	const slug = process.cwd().replace(/\//g, "-");
	const directory = join(homedir(), ".claude", "projects", slug, "memory");
	return existsSync(directory) ? directory : undefined;
}

function contains(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function requestAccess(resolved: string, mode: AccessMode, ctx: ExtensionContext): Promise<string> {
	const repoRoot = findRepoRoot();
	if (!ctx.hasUI) {
		throw new Error(
			`${resolved} is outside ${repoRoot} and there is no interactive UI to ask for access. Stay inside the repository.`,
		);
	}

	// Granting the whole enclosing repository beats granting a single directory: the next
	// read in a neighbouring source file would otherwise prompt all over again.
	const grantRoot = findVcsRoot(dirname(resolved)) ?? dirname(resolved);
	const verb = mode === "read" ? "Read" : "Write";
	const choice = await ctx.ui.select(
		`${verb} outside ${repoRoot}?\n\n  ${resolved}\n\n  Allowing grants ${mode} access to ${grantRoot}`,
		[ALLOW_ONCE, ALLOW_SESSION, ALLOW_ALWAYS, DENY],
	);

	switch (choice) {
		case ALLOW_ONCE:
			return resolved;
		case ALLOW_SESSION:
			sessionRoots[mode].add(grantRoot);
			return resolved;
		case ALLOW_ALWAYS:
			sessionRoots[mode].add(grantRoot);
			await persistRoot(grantRoot, mode);
			return resolved;
		default:
			throw new Error(
				`${resolved} is outside ${repoRoot} and the user declined access. ` +
					"Do not retry this path and do not route around it with a different tool. " +
					"Say what you need it for so the user can allow it.",
			);
	}
}

async function loadConfig(): Promise<void> {
	if (configLoaded) return;
	configLoaded = true;

	const { readRoots, writeRoots } = await readConfig();
	for (const root of readRoots) {
		configuredRoots.read.add(root);
	}
	for (const root of writeRoots) {
		configuredRoots.write.add(root);
	}
}

async function readConfig(): Promise<{ readRoots: string[]; writeRoots: string[] }> {
	try {
		const parsed = JSON.parse(await readFile(CONFIG_FILE, "utf8")) as Record<string, unknown>;
		return { readRoots: rootList(parsed.readRoots), writeRoots: rootList(parsed.writeRoots) };
	} catch {
		return { readRoots: [], writeRoots: [] };
	}
}

function rootList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string").map((item) => resolve(expandHome(item)));
}

// Re-reads before writing so roots the user added by hand survive an "Allow always".
async function persistRoot(root: string, mode: AccessMode): Promise<void> {
	const config = await readConfig();
	const key = mode === "read" ? "readRoots" : "writeRoots";
	const roots = [...new Set([...config[key], root])].sort();

	await mkdir(dirname(CONFIG_FILE), { recursive: true });
	await writeFile(CONFIG_FILE, `${JSON.stringify({ ...config, [key]: roots }, null, 2)}\n`);
}

function expandHome(path: string): string {
	return path === "~" || path.startsWith(`~${sep}`) ? join(homedir(), path.slice(1)) : path;
}
