import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type {
  AgentToolResult,
  FindToolDetails,
  GrepToolDetails,
  LsToolDetails,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  truncateLine,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { Static } from "typebox";
import { errorMessage } from "./errors.ts";
import { GrepCollector, GrepRowKind, LineOutcome, parseRipgrepEvent } from "./grep-collector.ts";
import { expandHome } from "./path-resolution.ts";
import { insideGitRepository, locateBinary } from "./search-binaries.ts";

// The built-in grep/find tools cannot express "files with matches" or "only directories", and
// their internals are not importable (the package's exports map is closed), so these executes
// drive rg/fd directly. Output shape and details keys mirror the built-ins so their renderers
// keep working unchanged.

// The defaults of pi's built-in tools, which the tool descriptions promise as well.
export const GREP_DEFAULT_LIMIT = 100;
export const FIND_DEFAULT_LIMIT = 1000;
export const LS_DEFAULT_LIMIT = 500;
// truncateLine's default (pi's GREP_MAX_LINE_LENGTH, which the package does not export).
export const MAX_LINE_LENGTH = 500;
// The limit hint suggests doubling, so a second call is enough in most cases.
const LIMIT_GROWTH_FACTOR = 2;

const outputParameter = Type.Optional(
  StringEnum(["results", "count"] as const, {
    description:
      "Return matching results, or only their exact count (default: results)",
  }),
);

export const lsParameters = Type.Object({
  path: Type.Optional(
    Type.String({
      description: "Directory to list (default: current directory)",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description:
        `Maximum number of entries to return (default: ${LS_DEFAULT_LIMIT}); ignored when output is count`,
    }),
  ),
  output: outputParameter,
});

export const findParameters = Type.Object({
  pattern: Type.String({
    description:
      "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
  }),
  path: Type.Optional(
    Type.String({
      description: "Directory to search in (default: current directory)",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description:
        `Maximum number of results to return (default: ${FIND_DEFAULT_LIMIT}); ignored when output is count`,
    }),
  ),
  output: outputParameter,
  type: Type.Optional(
    Type.Union(
      [
        Type.Literal("file"),
        Type.Literal("directory"),
        Type.Literal("symlink"),
      ],
      {
        description: "Restrict results to this entry type (default: all types)",
      },
    ),
  ),
});

export const grepParameters = Type.Object({
  pattern: Type.String({
    description: "Search pattern (regex or literal string)",
  }),
  path: Type.Optional(
    Type.String({
      description: "Directory or file to search (default: current directory)",
    }),
  ),
  glob: Type.Optional(
    Type.String({
      description:
        "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'",
    }),
  ),
  ignoreCase: Type.Optional(
    Type.Boolean({ description: "Case-insensitive search (default: false)" }),
  ),
  literal: Type.Optional(
    Type.Boolean({
      description:
        "Treat pattern as literal string instead of regex (default: false)",
    }),
  ),
  context: Type.Optional(
    Type.Number({
      description:
        "Number of lines to show before and after each match (default: 0)",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description:
        `Maximum number of matches to return (default: ${GREP_DEFAULT_LIMIT}); ignored when output is count`,
    }),
  ),
  filesOnly: Type.Optional(
    Type.Boolean({
      description:
        "Return only the paths of files containing matches, like grep -l; limit counts files and context is ignored (default: false)",
    }),
  ),
  output: outputParameter,
});
export type LsParameters = Static<typeof lsParameters>;

export function createGrepExecute(): ToolDefinition<typeof grepParameters, SearchDetails | undefined>["execute"] {
  return (_toolCallId, parameters, signal, _onUpdate, context) => searchGrep(parameters, context.cwd, signal);
}

export function createFindExecute(): ToolDefinition<typeof findParameters, SearchDetails | undefined>["execute"] {
  return (_toolCallId, parameters, signal, _onUpdate, context) => searchFind(parameters, context.cwd, signal);
}

export function createLsExecute(
  stockExecute: ToolDefinition<typeof lsParameters, LsToolDetails | undefined>["execute"],
): ToolDefinition<typeof lsParameters, LsToolDetails | undefined>["execute"] {
  return (toolCallId, parameters, signal, onUpdate, context) => {
    const { output, ...stockParameters } = parameters;
    if (output !== "count") {
      return stockExecute(toolCallId, stockParameters, signal, onUpdate, context);
    }

    return countEntries(resolvePath(parameters.path ?? ".", context.cwd), signal);
  };
}

export async function searchGrep(parameters: GrepParameters, cwd: string, signal: AbortSignal | undefined): Promise<SearchResult> {
  const {
    pattern,
    path: searchDirectory,
    glob,
    ignoreCase,
    literal,
    context: contextLines,
    limit,
    filesOnly,
    output,
  } = parameters;

  if (signal?.aborted) throw new Error("Operation aborted");
  const ripgrep = locateBinary("rg");
  const searchPath = resolvePath(searchDirectory ?? ".", cwd);
  const isDirectory = await stat(searchPath).then(
    (stats) => stats.isDirectory(),
    () => {
      throw new Error(`Path not found: ${searchPath}`);
    },
  );

  // Clamped so String() never yields exponent notation, which rg rejects.
  const contextValue =
    contextLines && contextLines > 0
      ? Math.min(Math.floor(contextLines), Number.MAX_SAFE_INTEGER)
      : 0;
  const countOnly = output === "count";
  const effectiveLimit = Math.max(1, Math.floor(limit ?? GREP_DEFAULT_LIMIT));

  const formatPath = (filePath: string): string => {
    if (isDirectory) {
      const relative = path.relative(searchPath, path.resolve(searchPath, filePath));
      if (relative && !relative.startsWith("..")) {
        return relative.replace(/\\/g, "/");
      }
    }
    return path.basename(filePath);
  };

  // --no-config keeps the tool contract independent of RIPGREP_CONFIG_PATH.
  const ripgrepArguments = filesOnly
    ? ["--no-config", "--files-with-matches", "--color=never", "--hidden"]
    : ["--no-config", "--json", "--line-number", "--color=never", "--hidden"];
  if (ignoreCase) ripgrepArguments.push("--ignore-case");
  if (literal) ripgrepArguments.push("--fixed-strings");
  if (glob) ripgrepArguments.push("--glob", withoutLeadingDotSlash(glob));
  if (!filesOnly && !countOnly && contextValue > 0) {
    ripgrepArguments.push("--context", String(contextValue));
  }
  if (!insideGitRepository(searchPath)) ripgrepArguments.push("--no-require-git");
  // rg roots --glob at its own working directory, so a directory search runs inside searchPath.
  // It searches "." because rg canonicalizes its working directory: with an absolute path, a
  // symlinked searchPath (macOS /tmp) would no longer lie under the glob root.
  ripgrepArguments.push("--", pattern, isDirectory ? "." : searchPath);
  const spawnOptions = { cwd: isDirectory ? searchPath : undefined, signal };

  if (filesOnly) {
    const matchedPaths: string[] = [];
    let fileCount = 0;
    const run = await runLines("ripgrep", ripgrep, ripgrepArguments, spawnOptions, (line) => {
      const filePath = line.replace(/\r$/, "").trim();
      if (!filePath) return LineOutcome.Continue;
      fileCount++;
      // One file past the limit proves that the limit cut results off.
      if (!countOnly && fileCount > effectiveLimit) return LineOutcome.Stop;
      if (!countOnly) matchedPaths.push(formatPath(filePath));
      return LineOutcome.Continue;
    });
    throwOnRipgrepFailure(run);
    if (countOnly) return textResult(`${fileCount} files with matches`);
    if (fileCount === 0) return textResult("No matches found");
    return searchResult(
      matchedPaths.join("\n"),
      run.stoppedEarly ? [limitNotice(effectiveLimit, "files")] : [],
    );
  }

  if (countOnly) {
    let matchCount = 0;
    const run = await runLines("ripgrep", ripgrep, ripgrepArguments, spawnOptions, (line) => {
      if (parseRipgrepEvent(line)?.type === "match") matchCount++;
      return LineOutcome.Continue;
    });
    throwOnRipgrepFailure(run);
    return textResult(`${matchCount} matches`);
  }

  const collector = new GrepCollector(effectiveLimit, contextValue);
  const run = await runLines("ripgrep", ripgrep, ripgrepArguments, spawnOptions, (line) => {
    const event = parseRipgrepEvent(line);
    return event ? collector.accept(event) : LineOutcome.Continue;
  });
  throwOnRipgrepFailure(run);
  if (collector.matchCount === 0) return textResult("No matches found");

  let linesTruncated = false;
  // Grouping by file prints each path once; rg emits a file's lines contiguously, but the map
  // keeps that true even if it ever interleaves.
  const rowsByFile = new Map<string, string[]>();
  for (const { filePath, lineNumber, text, kind } of collector.rows) {
    const { text: shown, wasTruncated } = truncateLine(text, MAX_LINE_LENGTH);
    if (wasTruncated) linesTruncated = true;
    const relativePath = formatPath(filePath);
    const rows = rowsByFile.get(relativePath) ?? [];
    rows.push(
      kind === GrepRowKind.Match ? `  ${lineNumber}: ${shown}` : `  ${lineNumber}- ${shown}`,
    );
    rowsByFile.set(relativePath, rows);
  }
  const outputLines = [...rowsByFile].flatMap(([relativePath, rows]) => [relativePath, ...rows]);

  const notices: Notice[] = [];
  if (collector.limitReached) notices.push(limitNotice(effectiveLimit, "matches"));
  if (linesTruncated) {
    notices.push({
      text: `Some lines truncated to ${MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
      details: { linesTruncated: true },
    });
  }
  return searchResult(outputLines.join("\n"), notices);
}

export type GrepParameters = Static<typeof grepParameters>;

const FD_TYPES = { file: "f", directory: "d", symlink: "l" } as const;

export async function searchFind(parameters: FindParameters, cwd: string, signal: AbortSignal | undefined): Promise<SearchResult> {
  const {
    pattern,
    path: searchDirectory,
    limit,
    type,
    output,
  } = parameters;

  if (signal?.aborted) throw new Error("Operation aborted");
  const fd = locateBinary("fd", ["fdfind"]);
  const searchPath = resolvePath(searchDirectory ?? ".", cwd);
  const countOnly = output === "count";
  const effectiveLimit = Math.max(1, Math.floor(limit ?? FIND_DEFAULT_LIMIT));
  const requestedPattern = withoutLeadingDotSlash(pattern);

  const fdArguments = ["--glob", "--color=never", "--hidden"];
  if (!insideGitRepository(searchPath)) fdArguments.push("--no-require-git");

  if (type) fdArguments.push("--type", FD_TYPES[type]);
  // One result past the limit proves that the limit cut results off.
  if (!countOnly) fdArguments.push("--max-results", String(effectiveLimit + 1));

  // fd --glob matches the basename unless --full-path is set. With it, fd matches the path as it
  // lists it, which begins with searchPath exactly as passed, so prefixing searchPath roots a path
  // pattern at the search directory, like grep's glob.
  const isPathPattern = requestedPattern.includes("/");
  if (isPathPattern) fdArguments.push("--full-path");
  const effectivePattern = isPathPattern ? rootedAt(searchPath, requestedPattern) : requestedPattern;
  fdArguments.push("--", effectivePattern, searchPath);

  const results: string[] = [];
  const run = await runLines("fd", fd, fdArguments, { signal }, (rawLine) => {
    const line = rawLine.replace(/\r$/, "").trim();
    if (line) results.push(line);
    return LineOutcome.Continue;
  });

  // fd exits non-zero for unreadable subtrees but still lists the rest.
  if (run.code !== 0 && results.length === 0) {
    throw new Error(run.stderr.trim() || `fd exited with code ${run.code}`);
  }
  if (countOnly) return textResult(`${results.length} matching entries`);
  if (results.length === 0) return textResult("No files found matching pattern");

  const limitReached = results.length > effectiveLimit;
  const relativized = results
    .slice(0, effectiveLimit)
    .map((line) => relativizeResultPath(line, searchPath));
  const notices: Notice[] = limitReached
    ? [
        {
          text: `${effectiveLimit} results limit reached. Use limit=${effectiveLimit * LIMIT_GROWTH_FACTOR} for more, or refine pattern`,
          details: { resultLimitReached: effectiveLimit },
        },
      ]
    : [];
  return searchResult(groupByDirectory(relativized), notices);
}

function rootedAt(searchPath: string, pattern: string): string {
  if (pattern.startsWith("/")) return pattern;
  // path.resolve keeps a trailing separator only on the filesystem root.
  const root = searchPath.endsWith("/") ? searchPath.slice(0, -1) : searchPath;
  return `${escapeGlob(root)}/${pattern}`;
}

// fd's globs treat these characters as syntax; a backslash makes them literal.
function escapeGlob(text: string): string {
  return text.replace(/[\\*?[\]{}]/g, "\\$&");
}

export type FindParameters = Static<typeof findParameters>;

function throwOnRipgrepFailure(run: RunOutcome): void {
  // rg exits 1 when nothing matched, which is a result and not a failure.
  if (run.stoppedEarly || run.code === 0 || run.code === 1) return;
  throw new Error(run.stderr.trim() || `ripgrep exited with code ${run.code}`);
}

function limitNotice(limit: number, unit: "matches" | "files"): Notice {
  return {
    text: `${limit} ${unit} limit reached. Use limit=${limit * LIMIT_GROWTH_FACTOR} for more, or refine pattern`,
    details: { matchLimitReached: limit },
  };
}

// rg and fd never match a leading "./" ("./src/*.ts" finds nothing); "!" negates an rg glob.
function withoutLeadingDotSlash(glob: string): string {
  return glob.replace(/^(!?)(?:\.\/)+/, "$1");
}

// Streams stdout line by line. A handler returning Stop kills the process once it has enough,
// and the caller then sees stoppedEarly instead of treating the kill as a failure.
function runLines(
  name: string,
  command: string,
  commandArguments: readonly string[],
  { cwd, signal }: SpawnOptions,
  onLine: (line: string) => LineOutcome,
): Promise<RunOutcome> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Operation aborted"));
      return;
    }
    const child = spawn(command, commandArguments, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const lineReader = createInterface({ input: child.stdout });
    let stderr = "";
    let stoppedEarly = false;

    const onAbort = (): void => {
      child.kill();
    };
    const cleanup = (): void => {
      lineReader.close();
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    lineReader.on("line", (line) => {
      if (stoppedEarly) return;
      if (onLine(line) === LineOutcome.Continue) return;
      stoppedEarly = true;
      child.kill();
    });
    child.on("error", (error) => {
      cleanup();
      reject(new Error(`Failed to run ${name}: ${error.message}`));
    });
    child.on("close", (code) => {
      cleanup();
      if (signal?.aborted) {
        reject(new Error("Operation aborted"));
        return;
      }
      resolve({ code, stderr, stoppedEarly });
    });
  });
}

interface RunOutcome {
  code: number | null;
  stderr: string;
  stoppedEarly: boolean;
}

interface SpawnOptions {
  cwd?: string;
  signal: AbortSignal | undefined;
}

function searchResult(body: string, notices: readonly Notice[]): SearchResult {
  // The result limit already caps the row count, so only the byte limit applies here.
  const truncation = truncateHead(body, { maxLines: Number.MAX_SAFE_INTEGER });
  const allNotices: readonly Notice[] = truncation.truncated
    ? [...notices, { text: `${formatSize(DEFAULT_MAX_BYTES)} limit reached`, details: { truncation } }]
    : notices;
  if (allNotices.length === 0) return textResult(truncation.content);
  const details: SearchDetails = {};
  for (const notice of allNotices) Object.assign(details, notice.details);
  return {
    content: [
      {
        type: "text",
        text: `${truncation.content}\n\n[${allNotices.map((notice) => notice.text).join(". ")}]`,
      },
    ],
    details,
  };
}

type SearchResult = AgentToolResult<SearchDetails | undefined>;

interface Notice {
  text: string;
  details: SearchDetails;
}

// The details keys of pi's built-in grep and find tools, so their renderers show the notices.
export type SearchDetails = GrepToolDetails & FindToolDetails;

export async function countEntries(
  directoryPath: string,
  signal: AbortSignal | undefined,
): Promise<AgentToolResult<undefined>> {
  const throwIfAborted = (): void => {
    if (signal?.aborted) throw new Error("Operation aborted");
  };
  throwIfAborted();
  const directoryStats = await stat(directoryPath).catch(() => {
    throw new Error(`Path not found: ${directoryPath}`);
  });
  if (!directoryStats.isDirectory()) {
    throw new Error(`Not a directory: ${directoryPath}`);
  }

  const entries = await readdir(directoryPath).catch((error: unknown) => {
    throwIfAborted();
    throw new Error(`Cannot read directory: ${errorMessage(error)}`);
  });

  let entryCount = 0;
  for (const entry of entries) {
    throwIfAborted();
    try {
      await stat(path.join(directoryPath, entry));
      entryCount++;
    } catch {
      // Match stock ls by skipping entries that cannot be statted.
    }
  }
  throwIfAborted();
  return textResult(`${entryCount} entries`);
}

function textResult(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

// Each directory prefix is printed once; on a repo-wide listing that is a third of the bytes.
export function groupByDirectory(relativePaths: readonly string[]): string {
  const namesByDirectory = new Map<string, string[]>();
  for (const relativePath of relativePaths) {
    if (!relativePath) continue;
    const isDirectory = relativePath.endsWith("/");
    const withoutSlash = isDirectory ? relativePath.slice(0, -1) : relativePath;
    const separator = withoutSlash.lastIndexOf("/");
    const directory =
      separator === -1 ? "./" : `${withoutSlash.slice(0, separator)}/`;
    const name = withoutSlash.slice(separator + 1) + (isDirectory ? "/" : "");
    const names = namesByDirectory.get(directory);
    if (names) {
      names.push(name);
    } else {
      namesByDirectory.set(directory, [name]);
    }
  }

  return [...namesByDirectory]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .flatMap(([directory, names]) => [directory, ...names.sort().map((name) => `  ${name}`)])
    .join("\n");
}

function relativizeResultPath(resultPath: string, searchPath: string): string {
  const hadTrailingSeparator = resultPath.endsWith(path.sep);
  const relativePath = path.isAbsolute(resultPath)
    ? path.relative(searchPath, resultPath)
    : resultPath;
  return hadTrailingSeparator && !relativePath.endsWith("/")
    ? `${relativePath}/`
    : relativePath;
}

function resolvePath(filePath: string, cwd: string): string {
  return path.resolve(cwd, expandHome(filePath));
}
