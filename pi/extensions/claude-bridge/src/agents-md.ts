// AGENTS.md discovery and sanitization for forwarding to Claude Code.
//
// Pi uses AGENTS.md for long-lived instructions; Claude Code reads the same
// content under "# CLAUDE.md". We forward the global context file from
// <piUserDir> (~/.pi/agent/AGENTS.md unless PI_CODING_AGENT_DIR points elsewhere)
// and the nearest one found walking up from cwd, and rewrite pi-specific references
// (~/.pi, .pi/, .pi, pi) to their Claude Code equivalents so any paths or
// references in the file still resolve inside the CC subprocess.
//
// Per directory we mirror the AGENTS.* entries of Pi's own candidate order
// (resource-loader.ts): AGENTS.override.md, AGENTS.md, AGENTS.MD -- the override
// replaces AGENTS.md in the same directory. Pi's list continues with CLAUDE.md and
// CLAUDE.MD, which we deliberately omit: the Claude Code subprocess already loads
// CLAUDE.md natively, so forwarding it would apply the same context twice.
//
// Pi loads the global file plus one context file per ancestor directory and
// concatenates them. We forward two layers, global first: the global file, because
// the Claude Code subprocess has no user-level AGENTS.md slot (only ~/.claude/CLAUDE.md,
// and the bridge runs it without filesystem settings anyway), and the NEAREST cwd
// ancestor file, which was the bridge's historical single layer. Intermediate ancestors
// are still skipped: the bridge sanitizes and re-headers whatever it forwards into one
// "# CLAUDE.md" block, so concatenating every layer risks duplicating context rather
// than completing it.
//
// In isolated mode (CLAUDE_BRIDGE_ISOLATED=1), all AGENTS.md discovery is
// disabled. Embedding hosts provide their instruction surface explicitly.

import { lstatSync, readFileSync, realpathSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { isolatedFromEnv, piUserDir } from "./config.js";
import { debug } from "./debug.js";

const CONTEXT_FILE_CANDIDATES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD"];

function contextFileInDir(dir: string): string | undefined {
	for (const filename of CONTEXT_FILE_CANDIDATES) {
		const candidate = join(dir, filename);
		try {
			if (statSync(candidate).isFile()) return candidate;
		} catch (error) {
			// A genuinely absent candidate is the normal case and stays silent. Anything else --
			// a dangling symlink (which reports ENOENT through stat but resolves through lstat),
			// a permissions error, an I/O fault -- means a context file the user intended is being
			// skipped, and skipping an override silently forwards the AGENTS.md it was meant to
			// supersede. Only ENOENT from lstat proves genuine absence; a traversal or permission
			// fault throws from both calls and must not be mistaken for "no such file".
			let lstatCode: string | undefined;
			let entryExists = false;
			try {
				lstatSync(candidate);
				entryExists = true;
			} catch (lstatError) {
				lstatCode = (lstatError as NodeJS.ErrnoException).code;
			}
			if (entryExists || lstatCode !== "ENOENT") {
				const detail = (error as NodeJS.ErrnoException).code ?? String(error);
				const suffix = entryExists ? "" : ` (lstat: ${lstatCode ?? "unknown"})`;
				debug(`agents-md: skipping unusable ${candidate}: ${detail}${suffix}`);
			}
		}
	}
	return undefined;
}

export function resolveAgentsMdPaths(): string[] {
	if (isolatedFromEnv()) return [];
	const paths: string[] = [];
	const seen = new Set<string>();
	for (const candidate of [contextFileInDir(piUserDir()), findAgentsMdInParents(process.cwd())]) {
		if (!candidate) continue;
		// The global file is often a symlink into a dotfiles repository; when cwd is that
		// repository the walk-up finds the same file under a second path.
		let identity = candidate;
		try {
			identity = realpathSync(candidate);
		} catch {
			// Unresolvable paths are deduplicated by their literal spelling instead.
		}
		if (seen.has(identity)) continue;
		seen.add(identity);
		paths.push(candidate);
	}
	return paths;
}

export function findAgentsMdInParents(startDir: string): string | undefined {
	let current = resolve(startDir);
	while (true) {
		const candidate = contextFileInDir(current);
		if (candidate) return candidate;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return undefined;
}

export function extractAgentsAppend(): string | undefined {
	const sections: string[] = [];
	for (const agentsPath of resolveAgentsMdPaths()) {
		try {
			const content = readFileSync(agentsPath, "utf-8").trim();
			if (!content) continue;
			const sanitized = sanitizeAgentsContent(content);
			if (sanitized.length > 0) sections.push(sanitized);
		} catch (error) {
			// An unreadable AGENTS.md silently drops the user's standing instructions
			// from every child prompt — degrade as before, but leave a trace.
			debug(`agents-md: failed to read ${agentsPath}:`, error instanceof Error ? error.message : String(error));
		}
	}
	if (sections.length === 0) return undefined;
	return `# CLAUDE.md\n\n${sections.join("\n\n")}`;
}

export function sanitizeAgentsContent(content: string): string {
	let sanitized = content;
	sanitized = sanitized.replace(/~\/\.pi\b/gi, "~/.claude");
	sanitized = sanitized.replace(/(^|[\s'"`])\.pi\//g, "$1.claude/");
	sanitized = sanitized.replace(/\b\.pi\b/gi, ".claude");
	sanitized = sanitized.replace(/\bpi\b/gi, "environment");
	return sanitized;
}
