import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execChecked } from "./lib/exec.ts";
import { detectMultiplexer, openPane } from "./lib/panes.ts";
import { registerToolWithGuidelines } from "./lib/register-tool.ts";
import { findRepoRoot } from "./lib/repo.ts";
import {
  activeSlugs,
  advanceQuiet,
  formatComments,
  pickNewSession,
  quietElapsed,
  type QuietState,
  type SessionEntry,
  type TuicrComment,
  unseenComments,
} from "./lib/tuicr-session.ts";

const TIMEOUT = 60_000;
const DEFAULT_AUTHOR = "pi";
const POLL_INTERVAL = 3_000;
const SESSION_APPEAR_TIMEOUT = 30_000;
const DEFAULT_QUIET_SECONDS = 10;
const DEFAULT_WAIT_TIMEOUT_SECONDS = 30 * 60;

interface Session {
  repo: string;
  slug: string;
  seen: Set<string>;
}

// The session opened by tuicr_open (or attached by tuicr_wait), so the other
// tools do not need repo/slug repeated on every call.
let current: Session | undefined;

export default function (pi: ExtensionAPI) {
  registerToolWithGuidelines(pi, {
    name: "tuicr_open",
    label: "Open tuicr",
    description:
      "Open tuicr, the terminal code review TUI, in a new pane of the surrounding multiplexer " +
      "(tmux or zellij) so the user can review a diff and leave inline comments. " +
      "Give range for a commit range or revset (git: main..HEAD; jj: main..@), workingTree for " +
      "uncommitted changes, both to combine them, or neither to let the user pick commits. " +
      "Returns as soon as the review session is running; it does not wait for comments.",
    promptSnippet: "Open tuicr in a new pane for the user to review",
    promptGuidelines: [
      "After tuicr_open, call tuicr_wait to receive the user's comments; do not poll tuicr yourself through bash.",
      "Do not add your own review comments to a session the user is reviewing unless they ask.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      range: Type.Optional(
        Type.String({
          description:
            "Commit range or revset passed to tuicr -r, e.g. main..HEAD or, for jj, main..@",
        }),
      ),
      workingTree: Type.Optional(
        Type.Boolean({ description: "Include uncommitted working-tree changes. Default: false" }),
      ),
      path: Type.Optional(Type.String({ description: "Limit the diff to this file or directory" })),
      repo: Type.Optional(
        Type.String({ description: "Repository directory. Default: the repository containing the current directory" }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate) {
      const { range, workingTree = false, path } = params;
      const repo = resolve(params.repo ?? findRepoRoot());
      const multiplexer = detectMultiplexer();
      if (!multiplexer) {
        throw new Error(
          "No supported multiplexer detected (tmux or zellij). " +
            `Ask the user to run tuicr in ${repo} themselves, then call tuicr_wait, which attaches to the active session.`,
        );
      }

      const activeBefore = activeSlugs(await listSessions(pi, repo, signal));
      const args = [
        "--no-update-check",
        ...(range ? ["-r", range] : []),
        ...(workingTree ? ["-w"] : []),
        ...(path ? ["-p", path] : []),
      ];
      await openPane(pi, multiplexer, repo, ["tuicr", ...args], signal);
      onUpdate?.({
        content: [{ type: "text", text: `tuicr started in a ${multiplexer} pane, waiting for its session…` }],
        details: {},
      });

      const entry = await waitForSession(pi, repo, activeBefore, signal);
      if (!entry) {
        // Without -r/-w tuicr shows a commit selector and has no session until the
        // user picks; tuicr_wait keeps looking for it.
        current = { repo, slug: "", seen: new Set() };
        return text(
          `tuicr is running in a ${multiplexer} pane for ${repo}, but has no active review session yet ` +
            "(the user may still be choosing commits). Call tuicr_wait; it attaches once a session appears.",
        );
      }
      const existing = await readComments(pi, repo, entry.slug, signal);
      current = { repo, slug: entry.slug, seen: new Set(existing.map((comment) => comment.id)) };
      const carried =
        existing.length > 0
          ? ` The session already holds ${existing.length} comment(s) from an earlier review; pass all: true to tuicr_wait to see them.`
          : "";
      return text(
        `tuicr is running in a ${multiplexer} pane reviewing ${describeTarget(range, workingTree, path)} in ${repo}.\n` +
          `Session: ${entry.slug}.${carried}\nCall tuicr_wait to receive the user's comments.`,
      );
    },
  });

  registerToolWithGuidelines(pi, {
    name: "tuicr_wait",
    label: "Wait for tuicr comments",
    description:
      "Wait for the user to write comments in the open tuicr review and return the new ones. " +
      "Returns once new comments exist and none were added for quietSeconds, or when the user closes tuicr, " +
      "or after timeoutSeconds with nothing new. With all set it returns every comment in the session immediately " +
      "instead of waiting. Attaches to the active tuicr session for the repository when tuicr_open was not called.",
    promptSnippet: "Wait for the user's tuicr comments",
    promptGuidelines: [
      "Treat the returned comments as review feedback: fix issues first, consider suggestions or say why not, answer notes, praise needs no action.",
      "If tuicr_wait reports that tuicr is still open after you addressed the comments, call it again; only stop when tuicr has exited or the user says the review is done.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      quietSeconds: Type.Optional(
        Type.Number({ description: `Seconds without new comments before returning. Default: ${DEFAULT_QUIET_SECONDS}` }),
      ),
      timeoutSeconds: Type.Optional(
        Type.Number({ description: `Give up waiting after this long. Default: ${DEFAULT_WAIT_TIMEOUT_SECONDS}` }),
      ),
      all: Type.Optional(
        Type.Boolean({ description: "Return all comments in the session now, including ones already reported. Default: false" }),
      ),
      session: Type.Optional(Type.String({ description: "Session slug from tuicr, when not the one tuicr_open started" })),
      repo: Type.Optional(Type.String({ description: "Repository directory, when not the one tuicr_open used" })),
    }),

    async execute(_toolCallId, params, signal, onUpdate) {
      const {
        quietSeconds = DEFAULT_QUIET_SECONDS,
        timeoutSeconds = DEFAULT_WAIT_TIMEOUT_SECONDS,
        all = false,
      } = params;
      const deadline = Date.now() + timeoutSeconds * 1000;
      let quiet: QuietState | undefined;

      while (true) {
        const session = await resolveSession(pi, params, deadline, signal);
        const entry = (await listSessions(pi, session.repo, signal)).find(
          (candidate) => candidate.slug === session.slug,
        );
        const comments = entry ? await readComments(pi, session.repo, session.slug, signal) : [];
        const unseen = unseenComments(comments, session.seen);

        if (all) {
          markSeen(session, comments);
          return text(formatComments(comments), { comments });
        }

        // A session that vanished or went inactive means the TUI exited (tuicr
        // deletes empty sessions on exit, so absence counts as exit too).
        if (!entry?.active) {
          markSeen(session, comments);
          const body =
            unseen.length > 0
              ? `${formatComments(unseen)}\n\ntuicr has exited; the review is over.`
              : "tuicr has exited without new comments; the review is over.";
          return text(body, { comments: unseen, exited: true });
        }

        const now = Date.now();
        quiet = advanceQuiet(quiet, unseen.length, now);
        if (quietElapsed(quiet, now, quietSeconds * 1000)) {
          markSeen(session, unseen);
          return text(
            `${formatComments(unseen)}\n\ntuicr is still open. Address these comments, then call tuicr_wait again.`,
            { comments: unseen, exited: false },
          );
        }
        if (now >= deadline) {
          return text(
            `No new comments after ${Math.round(timeoutSeconds / 60)} minutes; tuicr is still open. Call tuicr_wait again to keep waiting.`,
            { comments: [], exited: false },
          );
        }

        onUpdate?.({
          content: [
            {
              type: "text",
              text:
                unseen.length > 0
                  ? `${unseen.length} new comment(s), waiting for the user to pause…`
                  : `Waiting for comments in ${session.slug}…`,
            },
          ],
          details: {},
        });
        await sleep(POLL_INTERVAL, undefined, { signal });
      }
    },
  });

  registerToolWithGuidelines(pi, {
    name: "tuicr_comment",
    label: "Add tuicr comment",
    description:
      "Add comments to the current tuicr review session as the agent. Each entry has body (required); " +
      "path (file relative to the repository; omit for a review-level comment); line and optional endLine " +
      "for a line or range comment; side ('new' for added or unchanged lines, 'old' for removed lines; default new); " +
      "type (issue, suggestion, note or praise; default untyped). Comments are attributed to author so the user " +
      "can tell them from their own.",
    promptSnippet: "Add agent comments to the current tuicr review",
    promptGuidelines: [
      "Only add tuicr comments when the user asked you to review a patch; never comment on a review the user is writing themselves.",
    ],
    parameters: Type.Object({
      comments: Type.Array(
        Type.Object({
          body: Type.String({ description: "Comment text" }),
          path: Type.Optional(Type.String({ description: "File path relative to the repository" })),
          line: Type.Optional(Type.Number({ description: "Line number in the file" })),
          endLine: Type.Optional(Type.Number({ description: "Last line of a range comment" })),
          side: Type.Optional(StringEnum(["old", "new"] as const)),
          type: Type.Optional(Type.String({ description: "issue, suggestion, note or praise" })),
        }),
        { description: "The comments to add" },
      ),
      author: Type.Optional(Type.String({ description: `Attribution. Default: ${DEFAULT_AUTHOR}` })),
      session: Type.Optional(Type.String({ description: "Session slug, when not the one tuicr_open started" })),
      repo: Type.Optional(Type.String({ description: "Repository directory, when not the one tuicr_open used" })),
    }),

    async execute(_toolCallId, params, signal) {
      const { comments, author = DEFAULT_AUTHOR } = params;
      if (comments.length === 0) throw new Error("tuicr_comment needs at least one comment.");
      // deadline = now: attach only if a session is already active
      const session = await resolveSession(pi, params, Date.now(), signal);

      for (const comment of comments) {
        const { body, path, line, endLine, side, type } = comment;
        if ((line !== undefined || endLine !== undefined) && !path)
          throw new Error("A line comment needs a path.");
        if (endLine !== undefined && line === undefined) throw new Error("endLine needs line.");
        const output = await execChecked(
          pi,
          "tuicr",
          [
            "review",
            "add",
            "--repo",
            session.repo,
            "--session",
            session.slug,
            "--username",
            author,
            ...(type ? ["--type", type] : []),
            ...(path ? ["--target-file", path] : []),
            ...(line !== undefined ? ["--line", String(line)] : []),
            ...(endLine !== undefined ? ["--end-line", String(endLine)] : []),
            ...(side ? ["--side", side] : []),
            body,
          ],
          { signal, timeout: TIMEOUT },
        );
        // Only the comment just added counts as seen. Marking everything in the
        // session would swallow user comments written since the last tuicr_wait.
        markSeen(session, [JSON.parse(output) as TuicrComment]);
      }

      return text(`Added ${comments.length} comment(s) to ${session.slug} as ${author}.`);
    },
  });
}

function describeTarget(range: string | undefined, workingTree: boolean, path: string | undefined): string {
  let target: string;
  if (range && workingTree) target = `${range} plus the working tree`;
  else if (range) target = range;
  else if (workingTree) target = "the working tree";
  else target = "commits the user picks";
  return path ? `${target} (limited to ${path})` : target;
}

async function waitForSession(
  pi: ExtensionAPI,
  repo: string,
  activeBefore: ReadonlySet<string>,
  signal: AbortSignal | undefined,
): Promise<SessionEntry | undefined> {
  const deadline = Date.now() + SESSION_APPEAR_TIMEOUT;
  while (true) {
    const entries = await listSessions(pi, repo, signal);
    const picked = pickNewSession(entries, activeBefore);
    if (picked) return picked;
    if (Date.now() >= deadline) return undefined;
    await sleep(POLL_INTERVAL, undefined, { signal });
  }
}

interface SessionParams {
  session?: string;
  repo?: string;
}

async function resolveSession(
  pi: ExtensionAPI,
  params: SessionParams,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<Session> {
  if (params.session) {
    const repo = resolve(params.repo ?? current?.repo ?? findRepoRoot());
    const seen = current?.slug === params.session ? current.seen : new Set<string>();
    current = { repo, slug: params.session, seen };
    return current;
  }
  if (current && current.slug !== "") return current;

  const repo = current?.repo ?? resolve(params.repo ?? findRepoRoot());
  while (true) {
    const active = (await listSessions(pi, repo, signal)).filter((entry) => entry.active);
    const picked = active.sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
    if (picked) {
      current = { repo, slug: picked.slug, seen: new Set() };
      return current;
    }
    if (Date.now() >= deadline)
      throw new Error(`No active tuicr session in ${repo}. Call tuicr_open, or ask the user to start tuicr there.`);
    await sleep(POLL_INTERVAL, undefined, { signal });
  }
}

function markSeen(session: Session, comments: TuicrComment[]): void {
  for (const comment of comments) session.seen.add(comment.id);
}

async function listSessions(
  pi: ExtensionAPI,
  repo: string,
  signal: AbortSignal | undefined,
): Promise<SessionEntry[]> {
  const output = await execChecked(pi, "tuicr", ["review", "list", "--repo", repo], {
    signal,
    timeout: TIMEOUT,
  });
  return JSON.parse(output) as SessionEntry[];
}

// tuicr removes empty sessions when the TUI exits, so a failing read between the
// list and here just means "gone": report no comments rather than failing the wait.
async function readComments(
  pi: ExtensionAPI,
  repo: string,
  slug: string,
  signal: AbortSignal | undefined,
): Promise<TuicrComment[]> {
  try {
    const output = await execChecked(pi, "tuicr", ["review", "comments", "--repo", repo, "--session", slug], {
      signal,
      timeout: TIMEOUT,
    });
    return JSON.parse(output) as TuicrComment[];
  } catch {
    return [];
  }
}

function text(body: string, details: unknown = {}): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: body }], details };
}
