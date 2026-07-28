import { isAbsolute, relative, resolve } from "node:path";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { detectVcs, type VcsInfo } from "./lib/repo.ts";

const TIMEOUT = 60_000;
const DEFAULT_LOG_LIMIT = 20;

const PATHS_NOTE = "Paths are relative to the repository root and must stay inside it.";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "vcs_info",
		label: "VCS info",
		description:
			"Report which version control system backs the current directory, where its root is, and what the current revision is. " +
			"Says so plainly when there is no repository at all, so call this before assuming history exists.",
		promptSnippet: "Report the version control system, repository root and current revision",
		promptGuidelines: ["Use the vcs_* tools to inspect history instead of running jj or git through bash."],
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, signal) {
			const vcs = detectVcs();
			if (vcs.kind === "none") return missingVcs(vcs.root);

			const lines = [`VCS: ${vcs.kind}${vcs.colocated ? " (colocated with git)" : ""}`, `Root: ${vcs.root}`, ""];
			if (vcs.kind === "jj") {
				lines.push(await capture(pi, vcs, ["log", "-r", "@", "--no-graph"], [], signal));
			} else {
				const branch = await capture(pi, vcs, [], ["rev-parse", "--abbrev-ref", "HEAD"], signal);
				const head = await capture(pi, vcs, [], ["log", "-1", "--decorate", "--format=%h%d %an, %ar%n%s"], signal);
				const dirty = await capture(pi, vcs, [], ["status", "--porcelain"], signal);
				lines.push(`Branch: ${branch.trim()}`, "", head.trim(), "", dirty.trim() ? "Working tree dirty" : "Working tree clean");
			}
			return { content: [{ type: "text", text: lines.join("\n") }], details: { kind: vcs.kind } };
		},
	});

	pi.registerTool({
		name: "vcs_status",
		label: "VCS status",
		description: "Show the working copy status: which files were added, modified or deleted since the last commit.",
		promptSnippet: "Show which files changed in the working copy",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, signal) {
			return await report(pi, ["status"], ["status", "--short", "--branch"], signal);
		},
	});

	pi.registerTool({
		name: "vcs_log",
		label: "VCS log",
		description:
			"Show commit history. " +
			"Pass revisions as a jj revset in a jj repository (for example 'main..@' or '@-::') or as a git revision range otherwise. " +
			PATHS_NOTE,
		promptSnippet: "Show commit history, optionally for a revision range or specific paths",
		parameters: Type.Object({
			revisions: Type.Optional(Type.String({ description: "jj revset or git revision range. Defaults to recent history" })),
			limit: Type.Optional(Type.Number({ description: `Maximum number of revisions. Default: ${DEFAULT_LOG_LIMIT}` })),
			paths: Type.Optional(Type.Array(Type.String(), { description: "Limit history to these paths" })),
			stat: Type.Optional(Type.Boolean({ description: "Include a per-file change summary. Default: false" })),
		}),

		async execute(_toolCallId, params, signal) {
			const { revisions, limit = DEFAULT_LOG_LIMIT, paths, stat } = params;
			const jj = ["log", "-n", String(limit)];
			const git = ["log", "-n", String(limit), "--decorate", "--format=%h%d %an, %ar%n%s"];
			if (revisions) {
				jj.push("-r", revisions);
				git.push(revisions);
			}
			if (stat) {
				jj.push("--stat");
				git.push("--stat");
			}
			return await report(pi, jj, git, signal, paths);
		},
	});

	pi.registerTool({
		name: "vcs_show",
		label: "VCS show",
		description: `Show one revision: its metadata and the diff it introduced. ${PATHS_NOTE}`,
		promptSnippet: "Show the metadata and diff of a single revision",
		parameters: Type.Object({
			revision: Type.String({ description: "Revision to show: a jj change or commit id, or a git commit-ish" }),
			paths: Type.Optional(Type.Array(Type.String(), { description: "Limit the diff to these paths" })),
			stat: Type.Optional(Type.Boolean({ description: "Show a per-file summary instead of the full diff. Default: false" })),
		}),

		async execute(_toolCallId, params, signal) {
			const { revision, paths, stat } = params;
			const jj = ["show", revision];
			const git = ["show", revision];
			if (stat) {
				jj.push("--stat");
				git.push("--stat");
			}
			return await report(pi, jj, git, signal, paths);
		},
	});

	pi.registerTool({
		name: "vcs_diff",
		label: "VCS diff",
		description:
			"Show a diff. With no revisions this is the working copy against the last commit. " +
			"Otherwise pass a jj revset in a jj repository or a git commit-ish or range. " +
			PATHS_NOTE,
		promptSnippet: "Diff the working copy, a revision, or a range of revisions",
		parameters: Type.Object({
			revisions: Type.Optional(Type.String({ description: "jj revset or git commit-ish/range. Defaults to the working copy" })),
			paths: Type.Optional(Type.Array(Type.String(), { description: "Limit the diff to these paths" })),
			stat: Type.Optional(Type.Boolean({ description: "Show a per-file summary instead of the full diff. Default: false" })),
			context: Type.Optional(Type.Number({ description: "Lines of context around each change" })),
		}),

		async execute(_toolCallId, params, signal) {
			const { revisions, paths, stat, context } = params;
			const jj = ["diff"];
			// Bare `git diff` hides staged changes, which would silently disagree with jj.
			const git = ["diff", revisions ? revisions : "HEAD"];
			if (revisions) jj.push("-r", revisions);
			if (stat) {
				jj.push("--stat");
				git.push("--stat");
			}
			if (context !== undefined) {
				jj.push("--context", String(context));
				git.push(`-U${context}`);
			}
			return await report(pi, jj, git, signal, paths);
		},
	});

	pi.registerTool({
		name: "vcs_file",
		label: "VCS file",
		description: `Print the contents of a file as of a given revision. ${PATHS_NOTE}`,
		promptSnippet: "Print a file's contents at a specific revision",
		parameters: Type.Object({
			revision: Type.String({ description: "Revision to read the file from" }),
			path: Type.String({ description: "File path relative to the repository root" }),
		}),

		async execute(_toolCallId, params, signal) {
			const { revision, path } = params;
			const vcs = detectVcs();
			if (vcs.kind === "none") return missingVcs(vcs.root);

			const relativePath = repoRelative(vcs.root, path);
			const jj = ["file", "show", "-r", revision, relativePath];
			const git = ["show", `${revision}:${relativePath}`];
			return asResult(vcs, await capture(pi, vcs, jj, git, signal));
		},
	});

	pi.registerTool({
		name: "vcs_blame",
		label: "VCS blame",
		description: `Show which revision last changed each line of a file. ${PATHS_NOTE}`,
		promptSnippet: "Show the revision responsible for each line of a file",
		parameters: Type.Object({
			path: Type.String({ description: "File path relative to the repository root" }),
			revision: Type.Optional(Type.String({ description: "Revision to blame at. Defaults to the working copy" })),
		}),

		async execute(_toolCallId, params, signal) {
			const { path, revision } = params;
			const vcs = detectVcs();
			if (vcs.kind === "none") return missingVcs(vcs.root);

			const relativePath = repoRelative(vcs.root, path);
			const jj = ["file", "annotate", ...(revision ? ["-r", revision] : []), relativePath];
			const git = ["blame", ...(revision ? [revision] : []), "--", relativePath];
			return asResult(vcs, await capture(pi, vcs, jj, git, signal));
		},
	});
}

async function report(
	pi: ExtensionAPI,
	jj: string[],
	git: string[],
	signal: AbortSignal | undefined,
	paths?: string[],
): Promise<AgentToolResult<unknown>> {
	const vcs = detectVcs();
	if (vcs.kind === "none") return missingVcs(vcs.root);

	const separated = paths?.length ? ["--", ...paths.map((path) => repoRelative(vcs.root, path))] : [];
	return asResult(vcs, await capture(pi, vcs, [...jj, ...separated], [...git, ...separated], signal));
}

function missingVcs(root: string): AgentToolResult<unknown> {
	return {
		content: [
			{
				type: "text",
				text: `No jj or git repository at or above ${root}, so there is no history to inspect here.`,
			},
		],
		details: { kind: "none" },
	};
}

function repoRelative(root: string, path: string): string {
	const rel = relative(root, resolve(root, path));
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`${path} is outside the repository at ${root}. These tools only report on the current repository.`);
	}
	return rel || ".";
}

function asResult(vcs: VcsInfo, output: string): AgentToolResult<unknown> {
	const text = output.trim();
	return {
		content: [{ type: "text", text: text || "(no output)" }],
		details: { kind: vcs.kind },
	};
}

async function capture(
	pi: ExtensionAPI,
	vcs: VcsInfo,
	jj: string[],
	git: string[],
	signal: AbortSignal | undefined,
): Promise<string> {
	// -R and -C pin the command to the detected root, so a tool call cannot report on a
	// different repository just because the process cwd moved.
	const { command, args } =
		vcs.kind === "jj"
			? { command: "jj", args: ["-R", vcs.root, "--color=never", "--no-pager", ...jj] }
			: { command: "git", args: ["-C", vcs.root, "--no-pager", "-c", "color.ui=false", ...git] };

	const { stdout, stderr, code, killed } = await pi.exec(command, args, { signal, timeout: TIMEOUT, cwd: vcs.root });
	const invocation = `${command} ${args.join(" ")}`;

	if (killed) throw new Error(`${invocation} timed out after ${TIMEOUT / 1000}s.`);
	if (code !== 0) throw new Error(`${invocation} failed with exit ${code}: ${stderr.trim() || stdout.trim()}`);
	return stdout || stderr;
}
