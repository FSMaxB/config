import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getCurrentPlanPath } from "./lib/plan-file.ts";
import { serialize } from "./lib/ui-queue.ts";

const TIMEOUT = 60_000;
const TAIL_LINES = 12;
const DEFAULT_AUTHOR = "pi";

const PROCEED = "Send it";
const CANCEL = "Cancel";

// Set when crit_review starts a plan review. crit stores plan comments under the slug, and
// crit comment silently looks in the project root without it.
let planSlug: string | undefined;

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "crit_review",
		label: "Crit review",
		description:
			"Open a crit review in the browser and block until the user submits it, then return their comments. " +
			"Give at most one target: paths, pr, range, url, html, plan or story. " +
			"With no target this reviews the current plan file if there is one, and the branch diff otherwise.",
		promptSnippet: "Open a crit review and wait for the user's inline comments",
		promptGuidelines: [
			"Do not continue past a crit review until the user submits it, and address every unresolved comment before moving on.",
		],
		executionMode: "sequential",
		parameters: Type.Object({
			paths: Type.Optional(Type.Array(Type.String(), { description: "Files or directories to review" })),
			pr: Type.Optional(Type.String({ description: "GitHub pull request number or URL" })),
			range: Type.Optional(Type.String({ description: "Commit range, for example main..HEAD" })),
			url: Type.Optional(Type.String({ description: "URL of a running app, reviewed in live mode" })),
			html: Type.Optional(Type.String({ description: "Local .html file, reviewed in preview mode" })),
			plan: Type.Optional(Type.Boolean({ description: "Review the current plan file. Default: false" })),
			story: Type.Optional(Type.Boolean({ description: "Generate and review a story-mode diff. Default: false" })),
			session: Type.Optional(Type.String({ description: "Reconnect to an existing review session id" })),
			baseBranch: Type.Optional(Type.String({ description: "Branch to diff against, overriding auto-detection" })),
		}),

		async execute(_toolCallId, params, signal, onUpdate) {
			const { args, slug } = reviewArgs(params);
			const recent: string[] = [];

			const { output, code } = await streamCrit(args, signal, (line) => {
				recent.push(line);
				onUpdate?.({ content: [{ type: "text", text: recent.slice(-TAIL_LINES).join("\n") }], details: { args } });
			});

			if (slug) planSlug = slug;
			if (code !== 0) throw new Error(`crit ${args.join(" ")} exited with ${code}:\n${output.trim()}`);
			return { content: [{ type: "text", text: output.trim() || "crit produced no output." }], details: { args, slug } };
		},
	});

	pi.registerTool({
		name: "crit_comments",
		label: "Crit comments",
		description:
			"List the review comments crit is holding, review-level ones first. Unresolved only unless all is set. " +
			"This is the source of truth for what the user asked for, so prefer it over re-reading the review file.",
		promptSnippet: "List the comments from the current crit review",
		parameters: Type.Object({
			all: Type.Optional(Type.Boolean({ description: "Include resolved comments too. Default: false" })),
			plan: Type.Optional(Type.String({ description: "Plan slug, when the review is a plan review" })),
		}),

		async execute(_toolCallId, params, signal) {
			const { all, plan = planSlug } = params;
			const args = ["comments", "--json", ...(all ? ["--all"] : []), ...(plan ? ["--plan", plan] : [])];
			return await runCrit(pi, args, signal);
		},
	});

	pi.registerTool({
		name: "crit_comment",
		label: "Crit comment",
		description:
			"Add comments to the crit review, or reply to existing ones. Always attributed, always written in one atomic batch. " +
			"Each entry in comments is an object with: body (required); path (file path, relative to the repository); " +
			"line (a number as a string, or a range like '45-47'); endLine (number); replyTo (an existing comment id like c_a1b2c3 or r_f1e2d3); " +
			"scope ('line', 'file' or 'review'); resolve (boolean). " +
			"Scope is inferred when omitted: replyTo means a reply, path with line means a line comment, path alone means a file comment, " +
			"neither means review-level. " +
			"Only set resolve when the user explicitly asks for it; never resolve a comment on your own.",
		promptSnippet: "Add or reply to comments in the current crit review",
		promptGuidelines: [
			"Reply to every crit comment you addressed, saying what changed, before starting the next review round.",
		],
		parameters: Type.Object({
			comments: Type.Array(
				Type.Object({
					body: Type.String({ description: "Comment text, markdown" }),
					path: Type.Optional(Type.String({ description: "File path relative to the repository" })),
					line: Type.Optional(Type.String({ description: "Line number, or a range like 45-47" })),
					endLine: Type.Optional(Type.Number({ description: "Last line, when line is a single number" })),
					replyTo: Type.Optional(Type.String({ description: "Id of the comment being replied to" })),
					scope: Type.Optional(StringEnum(["line", "file", "review"] as const)),
					resolve: Type.Optional(Type.Boolean({ description: "Mark resolved. Only when the user asks" })),
				}),
				{ description: "The comments to write" },
			),
			author: Type.Optional(Type.String({ description: `Attribution. Default: ${DEFAULT_AUTHOR}` })),
			plan: Type.Optional(Type.String({ description: "Plan slug, when the review is a plan review" })),
		}),

		async execute(_toolCallId, params, signal) {
			const { comments, author = DEFAULT_AUTHOR, plan = planSlug } = params;
			if (comments.length === 0) throw new Error("crit_comment needs at least one comment.");

			const directory = await mkdtemp(join(tmpdir(), "pi-crit-"));
			const file = join(directory, "comments.json");
			try {
				await writeFile(file, JSON.stringify(comments.map(toCritEntry), null, 2));
				const args = ["comment", "--json", "--file", file, "--author", author, ...(plan ? ["--plan", plan] : [])];
				return await runCrit(pi, args, signal);
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
	});

	pi.registerTool({
		name: "crit_status",
		label: "Crit status",
		description: "Show the current crit session: the review file path, the round, and how many comments are outstanding.",
		promptSnippet: "Show the current crit session and comment counts",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, signal) {
			return await runCrit(pi, ["status"], signal);
		},
	});

	pi.registerTool({
		name: "crit_pull",
		label: "Crit pull",
		description: "Fetch review comments from a GitHub pull request into the local review file. Needs an authenticated gh CLI.",
		promptSnippet: "Fetch GitHub pull request comments into the crit review",
		parameters: Type.Object({
			pr: Type.Optional(Type.String({ description: "Pull request number. Auto-detected from the branch when omitted" })),
		}),

		async execute(_toolCallId, params, signal) {
			const { pr } = params;
			return await runCrit(pi, ["pull", ...(pr ? [pr] : [])], signal);
		},
	});

	pi.registerTool({
		name: "crit_push",
		label: "Crit push",
		description:
			"Post the local review comments to a GitHub pull request as a review. This is visible to everyone on the PR, " +
			"so the user is asked to confirm first. Needs an authenticated gh CLI.",
		promptSnippet: "Post the crit review to a GitHub pull request",
		executionMode: "sequential",
		parameters: Type.Object({
			pr: Type.Optional(Type.String({ description: "Pull request number. Auto-detected from the branch when omitted" })),
			event: Type.Optional(StringEnum(["comment", "approve", "request-changes"] as const)),
			message: Type.Optional(Type.String({ description: "Review-level body message" })),
			dryRun: Type.Optional(Type.Boolean({ description: "Print what would be posted without posting. Default: false" })),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { pr, event, message, dryRun } = params;
			const args = [
				"push",
				...(dryRun ? ["--dry-run"] : []),
				...(event ? ["--event", event] : []),
				...(message ? ["--message", message] : []),
				...(pr ? [pr] : []),
			];

			if (!dryRun) {
				const target = pr ? `pull request ${pr}` : "the pull request for this branch";
				const kind = event === "approve" ? "an approval" : event === "request-changes" ? "a change request" : "a review";
				const allowed = await confirm(ctx, `Post ${kind} to ${target} on GitHub?\n\n  crit ${args.join(" ")}`);
				if (!allowed) return declined("Nothing was posted to GitHub.");
			}
			return await runCrit(pi, args, signal);
		},
	});

	pi.registerTool({
		name: "crit_share",
		label: "Crit share",
		description:
			"Upload files to crit-web and return a shareable URL. This publishes their contents to a third-party service, " +
			"so the user is asked to confirm first.",
		promptSnippet: "Upload files to crit-web and return a share URL",
		executionMode: "sequential",
		parameters: Type.Object({
			paths: Type.Array(Type.String(), { description: "Files to share" }),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { paths } = params;
			if (paths.length === 0) throw new Error("crit_share needs at least one file.");

			const allowed = await confirm(ctx, `Upload these files to crit-web?\n\n  ${paths.join("\n  ")}`);
			if (!allowed) return declined("Nothing was uploaded.");
			return await runCrit(pi, ["share", ...paths], signal);
		},
	});

	pi.registerTool({
		name: "crit_unpublish",
		label: "Crit unpublish",
		description: "Remove a shared review from crit-web. The user is asked to confirm first.",
		promptSnippet: "Remove a shared review from crit-web",
		executionMode: "sequential",
		parameters: Type.Object({
			paths: Type.Optional(Type.Array(Type.String(), { description: "Files to unpublish. Defaults to the whole review" })),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { paths = [] } = params;
			const what = paths.length > 0 ? paths.join("\n  ") : "the current review";
			const allowed = await confirm(ctx, `Remove this from crit-web?\n\n  ${what}`);
			if (!allowed) return declined("Nothing was unpublished.");
			return await runCrit(pi, ["unpublish", ...paths], signal);
		},
	});
}

interface ReviewParams {
	paths?: string[];
	pr?: string;
	range?: string;
	url?: string;
	html?: string;
	plan?: boolean;
	story?: boolean;
	session?: string;
	baseBranch?: string;
}

function reviewArgs(params: ReviewParams): { args: string[]; slug?: string } {
	const { paths, pr, range, url, html, plan, story, session, baseBranch } = params;
	const chosen = [
		paths?.length ? "paths" : null,
		pr ? "pr" : null,
		range ? "range" : null,
		url ? "url" : null,
		html ? "html" : null,
		plan ? "plan" : null,
		story ? "story" : null,
		session ? "session" : null,
	].filter((name): name is string => name !== null);

	if (chosen.length > 1) {
		throw new Error(`crit reviews one target at a time, but ${chosen.join(", ")} were all set.`);
	}

	const base = baseBranch ? ["--base-branch", baseBranch] : [];
	if (paths?.length) return { args: [...paths, ...base] };
	if (pr) return { args: ["--pr", pr, ...base] };
	if (range) return { args: ["--range", range, ...base] };
	if (url) return { args: ["live", url] };
	if (html) return { args: ["preview", html] };
	if (story) return { args: ["story", ...base] };
	if (session) return { args: ["--session", session] };

	const planPath = getCurrentPlanPath();
	if (plan && !planPath) throw new Error("No plan file exists yet. Call write_plan first, or review something else.");
	if (!planPath) return { args: base };

	const slug = basename(planPath, ".md");
	return { args: ["plan", "--name", slug, planPath], slug };
}

// crit blocks for as long as the user is reviewing, so its output is streamed rather than
// collected at the end: the review URL it prints on startup is the only way back in if the
// browser does not open on its own.
function streamCrit(
	args: string[],
	signal: AbortSignal | undefined,
	onLine: (line: string) => void,
): Promise<{ output: string; code: number }> {
	return new Promise((resolve, reject) => {
		const child = spawn("crit", args, { stdio: ["ignore", "pipe", "pipe"] });
		const chunks: string[] = [];
		let pending = "";

		const abort = () => child.kill("SIGTERM");
		signal?.addEventListener("abort", abort, { once: true });

		const consume = (data: Buffer) => {
			const text = data.toString();
			chunks.push(text);
			pending += text;

			const lines = pending.split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) {
				onLine(line);
			}
		};

		child.stdout.on("data", consume);
		child.stderr.on("data", consume);
		child.on("error", (error) => {
			signal?.removeEventListener("abort", abort);
			reject(new Error(`Failed to run crit: ${error.message}`));
		});
		child.on("close", (code) => {
			signal?.removeEventListener("abort", abort);
			if (pending) onLine(pending);
			resolve({ output: chunks.join(""), code: code ?? 0 });
		});
	});
}

interface CommentParams {
	body: string;
	path?: string;
	line?: string;
	endLine?: number;
	replyTo?: string;
	scope?: string;
	resolve?: boolean;
}

function toCritEntry(comment: CommentParams): Record<string, unknown> {
	const { body, path, line, endLine, replyTo, scope, resolve } = comment;
	return {
		body,
		...(path ? { file: path } : {}),
		...(line ? { line } : {}),
		...(endLine !== undefined ? { end_line: endLine } : {}),
		...(replyTo ? { reply_to: replyTo } : {}),
		...(scope ? { scope } : {}),
		...(resolve ? { resolve: true } : {}),
	};
}

async function confirm(ctx: ExtensionContext, prompt: string): Promise<boolean> {
	if (!ctx.hasUI) return false;
	return (await serialize(() => ctx.ui.select(prompt, [PROCEED, CANCEL]))) === PROCEED;
}

function declined(detail: string): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: `The user declined. ${detail} Ask before trying again.` }],
		details: { declined: true },
	};
}

async function runCrit(pi: ExtensionAPI, args: string[], signal: AbortSignal | undefined): Promise<AgentToolResult<unknown>> {
	const { stdout, stderr, code, killed } = await pi.exec("crit", args, { signal, timeout: TIMEOUT });
	const invocation = `crit ${args.join(" ")}`;

	if (killed) throw new Error(`${invocation} timed out after ${TIMEOUT / 1000}s.`);
	if (code !== 0) throw new Error(`${invocation} failed with exit ${code}: ${stderr.trim() || stdout.trim()}`);

	const text = (stdout || stderr).trim();
	return { content: [{ type: "text", text: text || "(no output)" }], details: { args } };
}
