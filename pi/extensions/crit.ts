import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { isCritPlanApproved } from "./lib/crit-approval.ts";
import { fillPrepPath, hunkIdsFromPrep } from "./lib/crit-story.ts";
import { execChecked } from "./lib/exec.ts";
import { createLineSplitter } from "./lib/lines.ts";
import { commitPlanFileForUser } from "./lib/plan-commit.ts";
import { isInPlansDirectory } from "./lib/plan-file.ts";
import { canSubmitReviewedPlan, submitReviewedPlan } from "./lib/plan-submission.ts";
import { registerToolWithGuidelines } from "./lib/register-tool.ts";
import { sessionTemporaryDirectory } from "./lib/session-temporary-directory.ts";

const TIMEOUT = 60_000;
const TAIL_LINES = 12;
const DEFAULT_AUTHOR = "pi";

// Set when crit_review starts a plan review, and cleared on any successful non-plan review.
// crit stores plan comments under the slug, and crit comment silently looks in the project
// root without it.
let planSlug: string | undefined;

export default function (pi: ExtensionAPI) {
  registerToolWithGuidelines(pi, {
    name: "crit_review",
    exposure: "model-only",
    namespace: CRIT_NAMESPACE,
    label: "Crit review",
    description:
      "Open a crit review in the browser and block until the user submits it, then return their comments. " +
      "Give at most one target: paths, pr, range, url, html, plan or session. " +
      "With no target this reviews the branch diff. " +
      "story ingests an authored story-mode overview over the diff scope (no target, range or pr) before the review opens; " +
      "author it from the output of crit_story_prepare, and pass the same range, pr and baseBranch. " +
      "A plan file inside the plans directory is committed there before the review opens. " +
      "An explicitly approved plan review automatically opens the submission decision dialog while plan mode is active.",
    promptSnippet: "Open a crit review and wait for the user's inline comments",
    promptGuidelines: [
      "Do not continue past a crit review until the user submits it, and address every unresolved comment before moving on.",
      "Approved plan reviews automatically submit the plan; do not call submit_plan again. Crit approval alone does not leave plan mode: the user decides in the submission dialog.",
      "Only author a crit story when the user explicitly asks for one; a generic review, PR or diff request is not a story request.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      paths: Type.Optional(
        Type.Array(Type.String(), {
          description: "Files or directories to review",
        }),
      ),
      pr: Type.Optional(
        Type.String({ description: "GitHub pull request number or URL" }),
      ),
      range: Type.Optional(
        Type.String({ description: "Commit range, for example main..HEAD" }),
      ),
      url: Type.Optional(
        Type.String({
          description: "URL of a running app, reviewed in live mode",
        }),
      ),
      html: Type.Optional(
        Type.String({
          description: "Local .html file, reviewed in preview mode",
        }),
      ),
      plan: Type.Optional(
        Type.String({
          description: "Path of a plan file to review in plan mode",
        }),
      ),
      story: Type.Optional(STORY_SCHEMA),
      session: Type.Optional(
        Type.String({
          description: "Reconnect to an existing review session id",
        }),
      ),
      baseBranch: Type.Optional(
        Type.String({
          description: "Branch to diff against, overriding auto-detection",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, context) {
      const { args, slug } = reviewArgs(params);
      const { plan, story } = params;
      if (plan && isInPlansDirectory(plan)) {
        await commitPlanFileForUser(pi, context, plan, "review");
      }
      // reviewArgs only allows story with a diff scope, so args are exactly the scope flags here.
      const coverage = story ? await ingestStory(pi, story, args, signal) : undefined;
      const recent: string[] = [];

      const { output, stderr, code } = await streamCrit(args, signal, (line) => {
        recent.push(line);
        onUpdate?.({
          content: [
            { type: "text", text: recent.slice(-TAIL_LINES).join("\n") },
          ],
          details: { args },
        });
      });

      if (code !== 0) {
        if (signal?.aborted)
          throw new Error("The crit review was aborted before it started.");
        throw new Error(
          `crit ${args.join(" ")} exited with ${code}:\n${output.trim()}`,
        );
      }
      // Clears the slug for non-plan reviews, so a stale plan slug from an earlier review
      // doesn't leak into crit_comments/crit_comment defaults.
      planSlug = slug;
      const reviewText = output.trim() || "crit produced no output.";
      const reviewResult = {
        content: [
          { type: "text" as const, text: coverage ? `Story coverage: ${coverage}\n\n${reviewText}` : reviewText },
        ],
        details: { args, slug, coverage },
      };
      if (!plan || !isCritPlanApproved(stderr)) return reviewResult;
      signal?.throwIfAborted();
      if (!canSubmitReviewedPlan(pi.events, context)) return reviewResult;
      const submission = await submitReviewedPlan(
        pi.events,
        { path: plan },
        signal,
        context,
      );
      return {
        ...submission,
        content: [...reviewResult.content, ...submission.content],
        details: { ...reviewResult.details, submission: submission.details },
      };
    },
  });

  registerToolWithGuidelines(pi, {
    name: "crit_story_prepare",
    exposure: "model-only",
    namespace: CRIT_NAMESPACE,
    label: "Crit story prepare",
    description:
      "Start authoring a crit story: a chaptered, editorial overview of a diff that crit shows above the file list, " +
      "so the reviewer understands the shape of the change before reading hunks. " +
      "Returns crit's authoring guide (the source of truth for principles and JSON shape), the path of a prep file holding the full diff, " +
      "and the number of hunks in it. Read the prep file with the read tool; its hunk headers `--- (file_path, old_start) [status]` are the ids a story references. " +
      "Then cluster hunks by theme, not by file, into chapters, put mechanical noise into support with a reason, " +
      "and pass the result as story to crit_review with the same range, pr and baseBranch. " +
      "A story explains what changed and why the hunks belong together; it does not hunt bugs, judge the change or suggest fixes, " +
      "and it adds no review comments.",
    promptSnippet: "Fetch crit's story guide and the diff prep file to author a story-mode overview",
    promptGuidelines: [
      "Only author a crit story when the user explicitly asks for one; a generic review, PR or diff request is not a story request.",
      "Address comments from a story review in the source files, not in the story JSON, unless the user asks to change the story.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      pr: Type.Optional(
        Type.String({ description: "GitHub pull request number or URL" }),
      ),
      range: Type.Optional(
        Type.String({ description: "Commit range, for example main..HEAD" }),
      ),
      baseBranch: Type.Optional(
        Type.String({
          description: "Branch to diff against, overriding auto-detection",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, context) {
      const { args: scopeArgs } = reviewArgs(params);
      const directory = sessionTemporaryDirectory(context.sessionManager.getSessionId());
      await mkdir(directory, { recursive: true });
      const prepPath = join(directory, "crit-story-prep.txt");
      const guide = await execChecked(pi, "crit", ["story", "--guide", ...scopeArgs], { signal, timeout: TIMEOUT });
      await execChecked(pi, "crit", ["story", "--prep", prepPath, ...scopeArgs], { signal, timeout: TIMEOUT });
      const hunkIds = hunkIdsFromPrep(await readFile(prepPath, "utf8"));
      const text = [
        `Prep file with the full diff (read it): ${prepPath}`,
        `Hunks: ${hunkIds.length}. Each must appear in exactly one chapter or support entry.`,
        "",
        fillPrepPath(guide, prepPath).trim(),
      ].join("\n");
      return { content: [{ type: "text", text }], details: { prepPath, hunkIds, args: scopeArgs } };
    },
  });

  pi.registerTool({
    name: "crit_comments",
    namespace: CRIT_NAMESPACE,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    label: "Crit comments",
    description:
      "List the review comments crit is holding, review-level ones first. Unresolved only unless all is set. " +
      "This is the source of truth for what the user asked for, so prefer it over re-reading the review file.",
    promptSnippet: "List the comments from the current crit review",
    parameters: Type.Object({
      all: Type.Optional(
        Type.Boolean({
          description: "Include resolved comments too. Default: false",
        }),
      ),
      plan: Type.Optional(
        Type.String({
          description: "Plan slug, when the review is a plan review",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const { all, plan = planSlug } = params;
      const args = [
        "comments",
        "--json",
        ...(all ? ["--all"] : []),
        ...(plan ? ["--plan", plan] : []),
      ];
      return await runCrit(pi, args, signal);
    },
  });

  registerToolWithGuidelines(pi, {
    name: "crit_comment",
    namespace: CRIT_NAMESPACE,
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
          path: Type.Optional(
            Type.String({
              description: "File path relative to the repository",
            }),
          ),
          line: Type.Optional(
            Type.String({ description: "Line number, or a range like 45-47" }),
          ),
          endLine: Type.Optional(
            Type.Number({
              description: "Last line, when line is a single number",
            }),
          ),
          replyTo: Type.Optional(
            Type.String({ description: "Id of the comment being replied to" }),
          ),
          scope: Type.Optional(StringEnum(["line", "file", "review"] as const)),
          resolve: Type.Optional(
            Type.Boolean({
              description: "Mark resolved. Only when the user asks",
            }),
          ),
        }),
        { description: "The comments to write" },
      ),
      author: Type.Optional(
        Type.String({ description: `Attribution. Default: ${DEFAULT_AUTHOR}` }),
      ),
      plan: Type.Optional(
        Type.String({
          description: "Plan slug, when the review is a plan review",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const { comments, author = DEFAULT_AUTHOR, plan = planSlug } = params;
      if (comments.length === 0)
        throw new Error("crit_comment needs at least one comment.");

      const directory = await mkdtemp(join(tmpdir(), "pi-crit-"));
      const file = join(directory, "comments.json");
      try {
        await writeFile(
          file,
          JSON.stringify(comments.map(toCritEntry), null, 2),
        );
        const args = [
          "comment",
          "--json",
          "--file",
          file,
          "--author",
          author,
          ...(plan ? ["--plan", plan] : []),
        ];
        return await runCrit(pi, args, signal);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  });

  pi.registerTool({
    name: "crit_status",
    namespace: CRIT_NAMESPACE,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    label: "Crit status",
    description:
      "Show the current crit session: the review file path, the round, and how many comments are outstanding.",
    promptSnippet: "Show the current crit session and comment counts",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, signal) {
      return await runCrit(pi, ["status"], signal);
    },
  });
}

const CRIT_NAMESPACE = { name: "crit", description: "Open browser reviews and inspect or contribute review comments." };

const HUNK_REF_SCHEMA = Type.Object({
  file_path: Type.String({ description: "File path exactly as written in the prep file hunk header" }),
  old_start: Type.Integer({ description: "old_start from the prep file hunk header; 0 for new files" }),
});

const STORY_SCHEMA = Type.Object(
  {
    prologue: Type.Object({
      title: Type.String({ description: "At most 48 characters" }),
      overview: Type.String({ description: "1-3 sentences that stand alone without the chapters" }),
      motivation: Type.Optional(Type.String({ description: "Why these changes exist" })),
      key_changes: Type.Array(Type.String(), { description: "Concise bullets" }),
      risks: Type.Array(Type.String(), {
        description: "Concrete, scannable bullets; no verdicts or pass/fail commentary",
      }),
      diagram: Type.Optional(
        Type.String({
          description: "Mermaid diagram; omit unless it clarifies a non-obvious structure. At most one per story",
        }),
      ),
    }),
    chapters: Type.Array(
      Type.Object({
        id: Type.String({ description: "For example ch1" }),
        title: Type.String({ description: "At most 48 characters" }),
        summary: Type.String({ description: "One line that stands alone" }),
        hunk_refs: Type.Array(HUNK_REF_SCHEMA),
        diagram: Type.Optional(Type.String({ description: "Mermaid diagram; omit by default" })),
      }),
      {
        description:
          "Themes, not files; cross-file grouping is expected. Array order is reading order. 2-6 typical, 8 at most, roughly 1-6 hunks each",
      },
    ),
    support: Type.Array(
      Type.Object({
        hunk_refs: Type.Array(HUNK_REF_SCHEMA),
        reason: Type.String({ description: "For example: Lockfile churn." }),
      }),
      {
        description:
          "Mechanical hunks that need no editorial attention: lockfiles, generated code, dependency bumps, data dumps",
      },
    ),
  },
  {
    description:
      "Authored story-mode overview. Every hunk id from the prep file belongs to exactly one chapter or support entry; " +
      "never invent ids or re-quote diff text. Only prologue, chapters and support: crit fills version, SHAs and coverage.",
  },
);

type Story = Static<typeof STORY_SCHEMA>;

interface ReviewParams {
  paths?: string[];
  pr?: string;
  range?: string;
  url?: string;
  html?: string;
  plan?: string;
  story?: Story;
  session?: string;
  baseBranch?: string;
}

function reviewArgs(params: ReviewParams): { args: string[]; slug?: string } {
  const { paths, pr, range, url, html, plan, story, session, baseBranch } =
    params;
  const chosen = [
    paths?.length ? "paths" : null,
    pr ? "pr" : null,
    range ? "range" : null,
    url ? "url" : null,
    html ? "html" : null,
    plan ? "plan" : null,
    session ? "session" : null,
  ].filter((name): name is string => name !== null);

  if (chosen.length > 1) {
    throw new Error(
      `crit reviews one target at a time, but ${chosen.join(", ")} were all set.`,
    );
  }
  const storyScopes = ["range", "pr"];
  if (story && chosen.some((name) => !storyScopes.includes(name))) {
    throw new Error(
      `A story needs a diff scope (no target, range or pr), but ${chosen.join(", ")} was set.`,
    );
  }

  const base = baseBranch ? ["--base-branch", baseBranch] : [];
  if (paths?.length) return { args: [...paths, ...base] };
  if (pr) return { args: ["--pr", pr, ...base] };
  if (range) return { args: ["--range", range, ...base] };
  if (url) return { args: ["live", url] };
  if (html) return { args: ["preview", html] };
  if (session) return { args: ["--session", session] };
  if (!plan) return { args: base };

  const slug = basename(plan, ".md");
  return { args: ["plan", "--name", slug, plan], slug };
}

// Ingest writes the story into crit's review file, starts or updates the review daemon and opens
// the browser, but returns at once; the caller's bare `crit` run is what waits for Finish Review.
// --refresh is required: without it crit keeps an existing story and silently skips the ingest.
async function ingestStory(
  pi: ExtensionAPI,
  story: Story,
  scopeArgs: string[],
  signal: AbortSignal | undefined,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-crit-"));
  const file = join(directory, "story.json");
  try {
    await writeFile(file, JSON.stringify(story, null, 2));
    const args = ["story", "--story-file", file, "--refresh", ...scopeArgs];
    const { stdout, stderr, code, killed } = await pi.exec("crit", args, { signal, timeout: TIMEOUT });
    if (killed) throw new Error(`crit ${args.join(" ")} timed out after ${TIMEOUT / 1000}s.`);
    if (code !== 0) {
      throw new Error(
        `crit rejected the story (exit ${code}):\n${stdout.trim()}\n${stderr.trim()}\n` +
          "duplicated: a hunk is claimed twice, pick one place. missing: unplaced hunks, add them to a chapter or support. " +
          "A JSON or shape error: fix the fields named. \"diff changed since prep\": call crit_story_prepare again and re-author. " +
          "Then call crit_review with the corrected story.",
      );
    }
    return stdout.trim();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// crit blocks for as long as the user is reviewing, so its output is streamed rather than
// collected at the end: the review URL it prints on startup is the only way back in if the
// browser does not open on its own.
function streamCrit(
  args: string[],
  signal: AbortSignal | undefined,
  onLine: (line: string) => void,
): Promise<{ output: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("The crit review was aborted before it started."));
      return;
    }

    const child = spawn("crit", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: string[] = [];
    const stderrChunks: string[] = [];
    const splitter = createLineSplitter(onLine);

    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });

    const consume = (data: Buffer) => {
      const text = data.toString();
      chunks.push(text);
      splitter.push(text);
    };

    child.stdout.on("data", consume);
    child.stderr.on("data", (data: Buffer) => {
      stderrChunks.push(data.toString());
      consume(data);
    });
    child.on("error", (error) => {
      signal?.removeEventListener("abort", abort);
      reject(new Error(`Failed to run crit: ${error.message}`));
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      splitter.flush();
      // A signal-killed child (our SIGTERM on abort) closes with a null code, which must not
      // be read as success.
      resolve({ output: chunks.join(""), stderr: stderrChunks.join(""), code: code ?? 1 });
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

async function runCrit(
  pi: ExtensionAPI,
  args: string[],
  signal: AbortSignal | undefined,
): Promise<AgentToolResult<unknown>> {
  const text = (
    await execChecked(pi, "crit", args, { signal, timeout: TIMEOUT })
  ).trim();
  return {
    content: [{ type: "text", text: text || "(no output)" }],
    details: { args },
  };
}
