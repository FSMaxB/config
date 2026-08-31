import { isAbsolute, relative, resolve } from "node:path";
import type {
  AgentToolResult,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execChecked } from "./lib/exec.ts";
import { registerToolWithGuidelines } from "./lib/register-tool.ts";
import { detectVcs, type VcsInfo } from "./lib/repo.ts";

const TIMEOUT = 60_000;
const DEFAULT_LOG_LIMIT = 20;
const DEFAULT_STATUS_LIMIT = 50;

const PATHS_NOTE =
  "Paths are relative to the repository root and must stay inside it.";

// Appended to a truncation notice, so the model can see how to get the rest instead of
// giving up on the tool.
const NARROW_HINT =
  "pass stat: true to see which files changed, then paths to narrow the output";
const PAGE_HINT = "pass offset/limit to page through the rest";

const CAP_NOTE =
  `Output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB, ` +
  "whichever is hit first.";

const REVSET_NOTE = revsetNote(detectVcs().kind);

export default function (pi: ExtensionAPI) {
  // Re-detected on every agent start rather than once at load, so a repository
  // initialized mid-session is still announced correctly.
  pi.on("before_agent_start", async (event) => {
    const vcs = detectVcs();
    const line =
      vcs.kind === "none"
        ? `There is no jj or git repository at or above ${vcs.root}.`
        : `The current directory is inside a ${vcs.kind}${vcs.colocated ? " (colocated jj/git)" : ""} repository rooted at ${vcs.root}.`;
    return {
      systemPrompt: `${event.systemPrompt}\n\n# Version control\n\n${line}`,
    };
  });

  registerToolWithGuidelines(pi, {
    name: "vcs_info",
    label: "VCS info",
    description:
      "Report which version control system backs the current directory, where its root is, and what the current revision is. " +
      "Says so plainly when there is no repository at all, so call this before assuming history exists.",
    promptSnippet:
      "Report the version control system, repository root and current revision",
    promptGuidelines: [
      "Use the vcs_* tools to inspect history instead of running jj or git through bash.",
    ],
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, signal) {
      const vcs = detectVcs();
      if (vcs.kind === "none") return missingVcs(vcs.root);

      const lines = [
        `VCS: ${vcs.kind}${vcs.colocated ? " (colocated with git)" : ""}`,
        `Root: ${vcs.root}`,
        "",
      ];
      if (vcs.kind === "jj") {
        lines.push(
          await capture(pi, vcs, ["log", "-r", "@", "--no-graph"], [], signal),
        );
      } else {
        const branch = await capture(
          pi,
          vcs,
          [],
          ["rev-parse", "--abbrev-ref", "HEAD"],
          signal,
        );
        const head = await capture(
          pi,
          vcs,
          [],
          ["log", "-1", "--decorate", "--format=%h%d %an, %ar%n%s"],
          signal,
        );
        const dirty = await capture(
          pi,
          vcs,
          [],
          ["status", "--porcelain"],
          signal,
        );
        lines.push(
          `Branch: ${branch.trim()}`,
          "",
          head.trim(),
          "",
          dirty.trim() ? "Working tree dirty" : "Working tree clean",
        );
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { kind: vcs.kind },
      };
    },
  });

  pi.registerTool({
    name: "vcs_status",
    label: "VCS status",
    description:
      "Show the working copy status: which files were added, modified or deleted since the last commit. " +
      `At most ${DEFAULT_STATUS_LIMIT} changed files are listed; truncation is marked in the output and limit raises the cap.`,
    promptSnippet: "Show which files changed in the working copy",
    parameters: Type.Object({
      limit: Type.Optional(
        Type.Number({
          description: `Maximum number of changed files to list. Default: ${DEFAULT_STATUS_LIMIT}`,
        }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const { limit = DEFAULT_STATUS_LIMIT } = params;
      const vcs = detectVcs();
      if (vcs.kind === "none") return missingVcs(vcs.root);

      const output = await capture(
        pi,
        vcs,
        ["status"],
        ["status", "--short", "--branch"],
        signal,
      );
      return asResult(
        vcs,
        limitChangedFiles(output, limit),
        "pass a larger limit only if you need the full list",
      );
    },
  });

  pi.registerTool({
    name: "vcs_log",
    label: "VCS log",
    description: `Show commit history. ${REVSET_NOTE} ${PATHS_NOTE} ${CAP_NOTE}`,
    promptSnippet:
      "Show commit history, optionally for a revision range or specific paths",
    parameters: Type.Object({
      revisions: Type.Optional(
        Type.String({
          description:
            "Full jj revset or git revision range. Defaults to recent history",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: `Maximum number of revisions. Default: ${DEFAULT_LOG_LIMIT}`,
        }),
      ),
      paths: Type.Optional(
        Type.Array(Type.String(), {
          description: "Limit history to these paths",
        }),
      ),
      stat: Type.Optional(
        Type.Boolean({
          description: "Include a per-file change summary. Default: false",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const { revisions, limit = DEFAULT_LOG_LIMIT, paths, stat } = params;
      const jj = ["log", "-n", String(limit)];
      const git = [
        "log",
        "-n",
        String(limit),
        "--decorate",
        "--format=%h%d %an, %ar%n%s",
      ];
      if (revisions) {
        jj.push("-r", revisions);
        git.push(revisions);
      }
      if (stat) {
        jj.push("--stat");
        git.push("--stat");
      }
      return await report(pi, jj, git, signal, paths, NARROW_HINT);
    },
  });

  pi.registerTool({
    name: "vcs_show",
    label: "VCS show",
    description:
      "Show one revision: its metadata and the diff it introduced. " +
      `${PATHS_NOTE} ${CAP_NOTE}`,
    promptSnippet: "Show the metadata and diff of a single revision",
    parameters: Type.Object({
      revision: Type.String({
        description:
          "Revision to show: a jj change or commit id, or a git commit-ish",
      }),
      paths: Type.Optional(
        Type.Array(Type.String(), {
          description: "Limit the diff to these paths",
        }),
      ),
      stat: Type.Optional(
        Type.Boolean({
          description:
            "Show a per-file summary instead of the full diff. Default: false",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const { revision, paths, stat } = params;
      const jj = ["show", revision];
      const git = ["show", revision];
      if (stat) {
        jj.push("--stat");
        git.push("--stat");
      }
      return await report(pi, jj, git, signal, paths, NARROW_HINT);
    },
  });

  pi.registerTool({
    name: "vcs_diff",
    label: "VCS diff",
    description:
      "Show a diff. With no revisions this is the working copy against the last commit. " +
      `${REVSET_NOTE} ${PATHS_NOTE} ${CAP_NOTE}`,
    promptSnippet: "Diff the working copy, a revision, or a range of revisions",
    parameters: Type.Object({
      revisions: Type.Optional(
        Type.String({
          description:
            "Full jj revset or git commit-ish/range. Defaults to the working copy",
        }),
      ),
      paths: Type.Optional(
        Type.Array(Type.String(), {
          description: "Limit the diff to these paths",
        }),
      ),
      stat: Type.Optional(
        Type.Boolean({
          description:
            "Show a per-file summary instead of the full diff. Default: false",
        }),
      ),
      context: Type.Optional(
        Type.Number({ description: "Lines of context around each change" }),
      ),
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
      return await report(pi, jj, git, signal, paths, NARROW_HINT);
    },
  });

  pi.registerTool({
    name: "vcs_file",
    label: "VCS file",
    description:
      `Print the contents of a file as of a given revision. ${PATHS_NOTE} ${CAP_NOTE} ` +
      "Pass offset and limit to page through a longer file.",
    promptSnippet: "Print a file's contents at a specific revision",
    parameters: Type.Object({
      revision: Type.String({ description: "Revision to read the file from" }),
      path: Type.String({
        description: "File path relative to the repository root",
      }),
      offset: Type.Optional(
        Type.Number({
          description: "1-based first line to return. Default: 1",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Maximum number of lines to return. Default: no slice",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const { revision, path, offset, limit } = params;
      const vcs = detectVcs();
      if (vcs.kind === "none") return missingVcs(vcs.root);

      const relativePath = repoRelative(vcs.root, path);
      const jj = ["file", "show", "-r", revision, relativePath];
      const git = ["show", `${revision}:${relativePath}`];
      const output = await capture(pi, vcs, jj, git, signal);
      return asResult(vcs, paginate(output, offset, limit), PAGE_HINT);
    },
  });

  pi.registerTool({
    name: "vcs_blame",
    label: "VCS blame",
    description:
      `Show which revision last changed each line of a file. ${PATHS_NOTE} ${CAP_NOTE} ` +
      "Pass offset and limit to page through a longer file.",
    promptSnippet: "Show the revision responsible for each line of a file",
    parameters: Type.Object({
      path: Type.String({
        description: "File path relative to the repository root",
      }),
      revision: Type.Optional(
        Type.String({
          description: "Revision to blame at. Defaults to the working copy",
        }),
      ),
      offset: Type.Optional(
        Type.Number({
          description: "1-based first line to return. Default: 1",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Maximum number of lines to return. Default: no slice",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const { path, revision, offset, limit } = params;
      const vcs = detectVcs();
      if (vcs.kind === "none") return missingVcs(vcs.root);

      const relativePath = repoRelative(vcs.root, path);
      const jj = [
        "file",
        "annotate",
        ...(revision ? ["-r", revision] : []),
        relativePath,
      ];
      const git = [
        "blame",
        ...(revision ? [revision] : []),
        "--",
        relativePath,
      ];
      const output = await capture(pi, vcs, jj, git, signal);
      return asResult(vcs, paginate(output, offset, limit), PAGE_HINT);
    },
  });
}

async function report(
  pi: ExtensionAPI,
  jj: string[],
  git: string[],
  signal: AbortSignal | undefined,
  paths: string[] | undefined,
  hint: string,
): Promise<AgentToolResult<unknown>> {
  const vcs = detectVcs();
  if (vcs.kind === "none") return missingVcs(vcs.root);

  const separated = paths?.length
    ? ["--", ...paths.map((path) => repoRelative(vcs.root, path))]
    : [];
  return asResult(
    vcs,
    await capture(
      pi,
      vcs,
      [...jj, ...separated],
      [...git, ...separated],
      signal,
    ),
    hint,
  );
}

// Only the per-file lines are capped; headers, the jj working copy/parent footer and any
// hints stay, so a truncated status still says which revision it describes.
function limitChangedFiles(output: string, limit: number): string {
  // jj prints "M path", git --short prints " M path" or "?? path".
  const changeLine = /^[ ACDMRU?!][ ACDMRU?!]? /;

  const kept: string[] = [];
  let shown = 0;
  let hidden = 0;
  let markerAt = 0;
  for (const line of output.split("\n")) {
    if (!changeLine.test(line)) {
      kept.push(line);
    } else if (shown < limit) {
      shown++;
      kept.push(line);
    } else {
      if (hidden === 0) markerAt = kept.length;
      hidden++;
    }
  }
  if (hidden === 0) return output;

  kept.splice(
    markerAt,
    0,
    `[truncated] ... and ${hidden} more changed files not listed ` +
      `(showing ${shown} of ${shown + hidden}; pass a larger limit to vcs_status to see more)`,
  );
  return kept.join("\n");
}

// Descriptions are baked at tool registration, so this reflects the repository pi was
// started in; each tool call still re-detects the VCS on its own.
function revsetNote(kind: VcsInfo["kind"]): string {
  switch (kind) {
    case "jj":
      return (
        "Revisions accept the full jj revset language: functions like ancestors(x), " +
        "descendants(x), heads(x), latest(x, n) and operators like 'main..@', 'x | y' or '~x'."
      );
    case "git":
      return "Revisions accept standard git revision syntax: a commit-ish or a range like 'main..HEAD'.";
    default:
      return (
        "In a jj repository revisions accept the full jj revset language (ancestors(x), heads(x), " +
        "latest(x, n), 'main..@', 'x | y'); in a git repository, standard git revision syntax " +
        "('main..HEAD'). The two syntaxes are not interchangeable."
      );
  }
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
    throw new Error(
      `${path} is outside the repository at ${root}. These tools only report on the current repository.`,
    );
  }
  return rel || ".";
}

// Every tool result goes through the same cap as the built-in read and bash tools, so a
// megabyte-sized diff or a huge file cannot swallow the context window. The hint says how to
// get the rest, so a truncated result stays actionable instead of looking like a dead end.
function asResult(
  vcs: VcsInfo,
  output: string,
  hint: string,
): AgentToolResult<unknown> {
  const trimmed = output.trim();
  if (!trimmed) {
    return {
      content: [{ type: "text", text: "(no output)" }],
      details: { kind: vcs.kind, truncated: false },
    };
  }

  const {
    content,
    truncated,
    totalLines,
    outputLines,
    maxBytes,
    firstLineExceedsLimit,
  } = truncateHead(trimmed);
  if (!truncated) {
    return {
      content: [{ type: "text", text: content }],
      details: { kind: vcs.kind, truncated: false },
    };
  }

  // A single overlong line (a minified file, a one-line diff hunk) truncates to nothing, so
  // say that rather than reporting no output.
  const text = firstLineExceedsLimit
    ? `[truncated] The first line alone exceeds the ${formatSize(maxBytes)} limit, so none of it is shown; ${hint}.`
    : `${content.trimEnd()}\n[truncated] Showing the first ${outputLines} of ${totalLines} lines ` +
      `(${DEFAULT_MAX_LINES} line / ${formatSize(maxBytes)} limit); ${hint}.`;
  return {
    content: [{ type: "text", text }],
    details: { kind: vcs.kind, truncated: true },
  };
}

// Line paging for whole-file output, which makes the cap above recoverable: a file longer
// than one result would otherwise be unreadable past the cap, since repo_read can only
// substitute when the revision happens to be the working copy.
function paginate(
  output: string,
  offset: number | undefined,
  limit: number | undefined,
): string {
  if (offset === undefined && limit === undefined) return output;

  const lines = output.split("\n");
  // A trailing newline leaves a final empty element that is not a real line.
  if (lines.at(-1) === "") lines.pop();

  const start = Math.max((offset ?? 1) - 1, 0);
  if (start >= lines.length) {
    return `(no lines: offset ${start + 1} starts past the end of this ${lines.length}-line file)`;
  }

  const slice = lines.slice(
    start,
    limit === undefined ? undefined : start + Math.max(limit, 0),
  );
  return `[lines ${start + 1}-${start + slice.length} of ${lines.length}]\n${slice.join("\n")}`;
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
      ? {
          command: "jj",
          args: ["-R", vcs.root, "--color=never", "--no-pager", ...jj],
        }
      : {
          command: "git",
          args: ["-C", vcs.root, "--no-pager", "-c", "color.ui=false", ...git],
        };

  return await execChecked(pi, command, args, {
    signal,
    timeout: TIMEOUT,
    cwd: vcs.root,
  });
}
