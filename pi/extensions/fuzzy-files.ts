import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, type AutocompleteProvider, fuzzyFilter } from "@earendil-works/pi-tui";

const MENTION = /(?:^|\s)@([^\s"]*)$/;
const FD_ARGS = ["--type", "f", "--type", "d", "--hidden", "--follow", "--exclude", ".git", "--strip-cwd-prefix", "--max-results", "200000"];
const MAX_SUGGESTIONS = 20;
const STALE_MS = 10_000;
const SCAN_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;

type Rank = (paths: string[], query: string, signal: AbortSignal) => Promise<string[]>;

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		const fd = await resolveBinary(pi, [join(homedir(), ".pi", "agent", "bin", "fd"), "fd", "fdfind"]);
		if (!fd) return;

		const rank = (await resolveBinary(pi, ["fzf"])) ? rankWithFzf : rankInProcess;
		const getEntries = createEntryLoader(pi, fd, ctx.cwd);
		void getEntries();

		ctx.ui.addAutocompleteProvider((current) => createProvider(current, getEntries, rank));
	});
}

async function resolveBinary(pi: ExtensionAPI, candidates: string[]): Promise<string | undefined> {
	for (const candidate of candidates) {
		if (candidate.includes("/") && !existsSync(candidate)) continue;
		const { code } = await pi.exec(candidate, ["--version"], { timeout: PROBE_TIMEOUT_MS });
		if (code === 0) return candidate;
	}
	return undefined;
}

function createEntryLoader(pi: ExtensionAPI, fd: string, cwd: string): () => Promise<string[]> {
	let paths: string[] = [];
	let scannedAt = 0;
	let scan: Promise<void> | undefined;

	const rescan = () => {
		scan ||= (async () => {
			const { stdout, code } = await pi.exec(fd, FD_ARGS, { cwd, timeout: SCAN_TIMEOUT_MS });
			if (code === 0) paths = stdout.split("\n").filter(Boolean);
			// Stamped even on failure so a broken scan backs off instead of rerunning per keystroke.
			scannedAt = Date.now();
			scan = undefined;
		})();
		return scan;
	};

	return async () => {
		if (scannedAt === 0) await rescan();
		else if (Date.now() - scannedAt > STALE_MS) void rescan();
		return paths;
	};
}

function createProvider(current: AutocompleteProvider, getEntries: () => Promise<string[]>, rank: Rank): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const delegate = () => current.getSuggestions(lines, cursorLine, cursorCol, options);
			const query = (lines[cursorLine] ?? "").slice(0, cursorCol).match(MENTION)?.[1];
			// Home and absolute paths keep the built-in directory listing, which avoids scanning $HOME.
			if (query === undefined || query.startsWith("~") || query.startsWith("/")) return delegate();

			const paths = await getEntries();
			if (options.signal.aborted) return null;
			if (paths.length === 0) return delegate();

			const ranked = await rank(paths, query, options.signal);
			if (options.signal.aborted || ranked.length === 0) return null;

			return { items: ranked.map(toItem), prefix: `@${query}` };
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

function rankWithFzf(paths: string[], query: string, signal: AbortSignal): Promise<string[]> {
	if (!query) return Promise.resolve(paths.slice(0, MAX_SUGGESTIONS));

	return new Promise((resolve) => {
		const child = spawn("fzf", ["--filter", query], { stdio: ["pipe", "pipe", "ignore"] });
		const matches: string[] = [];
		let pending = "";
		let settled = false;

		const finish = () => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", finish);
			child.kill("SIGKILL");
			resolve(matches);
		};

		signal.addEventListener("abort", finish, { once: true });
		child.stdout.setEncoding("utf-8");
		// fzf sorts the whole input before printing, so the first lines out are the best
		// matches and killing it once we have enough is what keeps broad queries cheap.
		child.stdout.on("data", (chunk: string) => {
			pending += chunk;
			const lines = pending.split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) {
				if (line) matches.push(line);
				if (matches.length >= MAX_SUGGESTIONS) return finish();
			}
		});
		child.on("error", finish);
		child.on("close", finish);
		child.stdin.on("error", () => {});
		child.stdin.end(`${paths.join("\n")}\n`);
	});
}

async function rankInProcess(paths: string[], query: string): Promise<string[]> {
	return fuzzyFilter(paths, query, (path) => path).slice(0, MAX_SUGGESTIONS);
}

function toItem(path: string): AutocompleteItem {
	const isDirectory = path.endsWith("/");
	const name = basename(path);
	return {
		value: path.includes(" ") ? `@"${path}"` : `@${path}`,
		label: isDirectory ? `${name}/` : name,
		description: isDirectory ? path.slice(0, -1) : path,
	};
}
