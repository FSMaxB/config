import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  truncateLine,
} from "@earendil-works/pi-coding-agent";
import { GrepCollector, GrepRowKind, LineOutcome, parseRipgrepEvent } from "./grep-collector.ts";
import { insideGitRepository, locateBinary } from "./search-binaries.ts";

// The built-in grep/find tools cannot express "files with matches" or "only directories", and
// their internals are not importable (the package's exports map is closed), so these executes
// drive rg/fd directly. Output shape and details keys mirror the built-ins so their renderers
// keep working unchanged.

export interface GrepParams {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
  filesOnly?: boolean;
  output?: "results" | "count";
}

export function createGrepExecute(
  cwd: string,
): ToolDefinition<any, any, any>["execute"] {
  const DEFAULT_LIMIT = 100;
  const MAX_LINE_LENGTH = 500;

  return async (_toolCallId, params, signal, _onUpdate, toolContext) => {
    const {
      pattern,
      path: searchDir,
      glob,
      ignoreCase,
      literal,
      context: contextLines,
      limit,
      filesOnly,
      output,
    } = params as GrepParams;

    if (signal?.aborted) throw new Error("Operation aborted");
    const ripgrep = locateBinary("rg");
    const searchPath = resolvePath(searchDir || ".", toolContext?.cwd || cwd);
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
    const effectiveLimit = Math.max(1, Math.floor(limit ?? DEFAULT_LIMIT));

    const formatPath = (filePath: string) => {
      if (isDirectory) {
        const relative = path.relative(searchPath, path.resolve(searchPath, filePath));
        if (relative && !relative.startsWith("..")) {
          return relative.replace(/\\/g, "/");
        }
      }
      return path.basename(filePath);
    };

    // --no-config keeps the tool contract independent of RIPGREP_CONFIG_PATH.
    const args = filesOnly
      ? ["--no-config", "--files-with-matches", "--color=never", "--hidden"]
      : ["--no-config", "--json", "--line-number", "--color=never", "--hidden"];
    if (ignoreCase) args.push("--ignore-case");
    if (literal) args.push("--fixed-strings");
    if (glob) args.push("--glob", withoutLeadingDotSlash(glob));
    if (!filesOnly && !countOnly && contextValue > 0) {
      args.push("--context", String(contextValue));
    }
    if (!insideGitRepository(searchPath)) args.push("--no-require-git");
    // rg roots --glob at its own working directory, so a directory search runs inside searchPath.
    // It searches "." because rg canonicalizes its working directory: with an absolute path, a
    // symlinked searchPath (macOS /tmp) would no longer lie under the glob root.
    args.push("--", pattern, isDirectory ? "." : searchPath);
    const spawnOptions = { cwd: isDirectory ? searchPath : undefined, signal };

    if (filesOnly) {
      const matchedPaths: string[] = [];
      let fileCount = 0;
      const run = await runLines("ripgrep", ripgrep, args, spawnOptions, (line) => {
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
      const run = await runLines("ripgrep", ripgrep, args, spawnOptions, (line) => {
        if (parseRipgrepEvent(line)?.type === "match") matchCount++;
        return LineOutcome.Continue;
      });
      throwOnRipgrepFailure(run);
      return textResult(`${matchCount} matches`);
    }

    const collector = new GrepCollector(effectiveLimit, contextValue);
    const run = await runLines("ripgrep", ripgrep, args, spawnOptions, (line) => {
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
      const { text: shown, wasTruncated } = truncateLine(text);
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
        detail: ["linesTruncated", true],
      });
    }
    return searchResult(outputLines.join("\n"), notices);
  };
}

export interface FindParams {
  pattern: string;
  path?: string;
  limit?: number;
  type?: "file" | "directory" | "symlink";
  output?: "results" | "count";
}

export interface LsParams {
  path?: string;
  limit?: number;
  output?: "results" | "count";
}

export function createFindExecute(
  cwd: string,
): ToolDefinition<any, any, any>["execute"] {
  const DEFAULT_LIMIT = 1000;
  const FD_TYPES = { file: "f", directory: "d", symlink: "l" } as const;

  return async (_toolCallId, params, signal, _onUpdate, toolContext) => {
    const {
      pattern,
      path: searchDir,
      limit,
      type,
      output,
    } = params as FindParams;

    if (signal?.aborted) throw new Error("Operation aborted");
    const fd = locateBinary("fd", ["fdfind"]);
    const searchPath = resolvePath(searchDir || ".", toolContext?.cwd || cwd);
    const countOnly = output === "count";
    const effectiveLimit = Math.max(1, Math.floor(limit ?? DEFAULT_LIMIT));
    const requestedPattern = withoutLeadingDotSlash(pattern);

    const args = ["--glob", "--color=never", "--hidden"];
    if (!insideGitRepository(searchPath)) args.push("--no-require-git");

    if (type) args.push("--type", FD_TYPES[type]);
    // One result past the limit proves that the limit cut results off.
    if (!countOnly) args.push("--max-results", String(effectiveLimit + 1));

    // fd --glob matches against the basename unless --full-path is set; in --full-path
    // mode it matches against the absolute candidate path, so a path-containing
    // pattern like 'src/**/*.spec.ts' needs a leading '**/' to match anything.
    let effectivePattern = requestedPattern;
    if (requestedPattern.includes("/")) {
      args.push("--full-path");
      if (
        !requestedPattern.startsWith("/") &&
        !requestedPattern.startsWith("**/") &&
        requestedPattern !== "**"
      ) {
        effectivePattern = `**/${requestedPattern}`;
      }
    }
    args.push("--", effectivePattern, searchPath);

    const results: string[] = [];
    const run = await runLines("fd", fd, args, { signal }, (rawLine) => {
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
            text: `${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
            detail: ["resultLimitReached", effectiveLimit],
          },
        ]
      : [];
    return searchResult(groupByDirectory(relativized), notices);
  };
}

function throwOnRipgrepFailure(run: RunOutcome): void {
  if (run.stoppedEarly || run.code === 0 || run.code === 1) return;
  throw new Error(run.stderr.trim() || `ripgrep exited with code ${run.code}`);
}

function limitNotice(limit: number, unit: "matches" | "files"): Notice {
  return {
    text: `${limit} ${unit} limit reached. Use limit=${limit * 2} for more, or refine pattern`,
    detail: ["matchLimitReached", limit],
  };
}

// rg and fd never match a leading "./" ("./src/*.ts" finds nothing); "!" negates an rg glob.
function withoutLeadingDotSlash(glob: string): string {
  return glob.replace(/^(!?)(?:\.\/)+/, "$1");
}

interface RunOutcome {
  code: number | null;
  stderr: string;
  stoppedEarly: boolean;
}

interface SpawnOptions {
  cwd?: string;
  signal?: AbortSignal;
}

// Streams stdout line by line. A handler returning Stop kills the process once it has enough,
// and the caller then sees stoppedEarly instead of treating the kill as a failure.
function runLines(
  name: string,
  command: string,
  args: string[],
  { cwd, signal }: SpawnOptions,
  onLine: (line: string) => LineOutcome,
): Promise<RunOutcome> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Operation aborted"));
      return;
    }
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const lineReader = createInterface({ input: child.stdout });
    let stderr = "";
    let stoppedEarly = false;

    const onAbort = () => child.kill();
    const cleanup = () => {
      lineReader.close();
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stderr.on("data", (chunk) => {
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

interface Notice {
  text: string;
  detail: [key: string, value: unknown];
}

function searchResult(
  body: string,
  notices: Notice[],
): AgentToolResult<Record<string, unknown> | undefined> {
  // The result limit already caps the row count, so only the byte limit applies here.
  const truncation = truncateHead(body, { maxLines: Number.MAX_SAFE_INTEGER });
  const allNotices: Notice[] = truncation.truncated
    ? [...notices, { text: `${formatSize(DEFAULT_MAX_BYTES)} limit reached`, detail: ["truncation", truncation] }]
    : notices;
  if (allNotices.length === 0) return textResult(truncation.content);
  return {
    content: [
      {
        type: "text",
        text: `${truncation.content}\n\n[${allNotices.map((notice) => notice.text).join(". ")}]`,
      },
    ],
    details: Object.fromEntries(allNotices.map((notice) => notice.detail)),
  };
}

function textResult(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

export function createLsExecute(
  cwd: string,
  stockExecute: ToolDefinition<any, any, any>["execute"],
): ToolDefinition<any, any, any>["execute"] {
  return (toolCallId, params, signal, onUpdate, context) => {
    const { output, ...stockParams } = params as LsParams;
    if (output !== "count") {
      return stockExecute(toolCallId, stockParams, signal, onUpdate, context);
    }

    return countEntries(resolvePath((params as LsParams).path || ".", context?.cwd || cwd), signal);
  };
}

async function countEntries(
  directoryPath: string,
  signal: AbortSignal | undefined,
): Promise<AgentToolResult<undefined>> {
  const throwIfAborted = () => {
    if (signal?.aborted) throw new Error("Operation aborted");
  };
  throwIfAborted();
  const directoryStats = await stat(directoryPath).catch(() => {
    throw new Error(`Path not found: ${directoryPath}`);
  });
  if (!directoryStats.isDirectory()) {
    throw new Error(`Not a directory: ${directoryPath}`);
  }

  const entries = await readdir(directoryPath).catch((error) => {
    throwIfAborted();
    throw new Error(`Cannot read directory: ${error instanceof Error ? error.message : String(error)}`);
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

// Each directory prefix is printed once; on a repo-wide listing that is a third of the bytes.
export function groupByDirectory(relativePaths: string[]): string {
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

  const lines: string[] = [];
  for (const directory of [...namesByDirectory.keys()].sort()) {
    lines.push(directory);
    for (const name of namesByDirectory.get(directory)!.sort())
      lines.push(`  ${name}`);
  }
  return lines.join("\n");
}

function relativizeResultPath(resultPath: string, searchPath: string) {
  const hadTrailingSeparator = resultPath.endsWith(path.sep);
  const relativePath = path.isAbsolute(resultPath)
    ? path.relative(searchPath, resultPath)
    : resultPath;
  return hadTrailingSeparator && !relativePath.endsWith("/")
    ? `${relativePath}/`
    : relativePath;
}

function resolvePath(filePath: string, cwd: string) {
  const expanded = filePath.startsWith("~")
    ? path.join(homedir(), filePath.slice(1))
    : filePath;
  return path.resolve(cwd, expanded);
}
