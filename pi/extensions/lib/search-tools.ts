import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
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

  return async (_toolCallId, params, signal) => {
    const {
      pattern,
      path: searchDir,
      glob,
      ignoreCase,
      literal,
      context,
      limit,
      filesOnly,
      output,
    } = params as GrepParams;

    if (signal?.aborted) throw new Error("Operation aborted");
    const ripgrep = locateBinary("rg");
    const searchPath = resolvePath(searchDir || ".", cwd);
    const isDirectory = await stat(searchPath).then(
      (stats) => stats.isDirectory(),
      () => {
        throw new Error(`Path not found: ${searchPath}`);
      },
    );

    const contextValue = context && context > 0 ? context : 0;
    const countOnly = output === "count";
    const effectiveLimit = countOnly
      ? Number.POSITIVE_INFINITY
      : Math.max(1, limit ?? DEFAULT_LIMIT);

    const formatPath = (filePath: string) => {
      if (isDirectory) {
        const relative = path.relative(searchPath, filePath);
        if (relative && !relative.startsWith("..")) {
          return relative.replace(/\\/g, "/");
        }
      }
      return path.basename(filePath);
    };

    const fileCache = new Map<string, string[]>();
    const getFileLines = async (filePath: string) => {
      let lines = fileCache.get(filePath);
      if (!lines) {
        try {
          const content = await readFile(filePath, "utf-8");
          lines = content
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n")
            .split("\n");
        } catch {
          lines = [];
        }
        fileCache.set(filePath, lines);
      }
      return lines;
    };

    const args = filesOnly
      ? ["--files-with-matches", "--color=never", "--hidden"]
      : ["--json", "--line-number", "--color=never", "--hidden"];
    if (ignoreCase) args.push("--ignore-case");
    if (literal) args.push("--fixed-strings");
    if (glob) args.push("--glob", glob);
    args.push("--", pattern, searchPath);

    let matchCount = 0;
    const matchedPaths: string[] = [];
    const matches: { filePath: string; lineNumber: number; lineText?: string }[] = [];

    const run = await runLines("ripgrep", ripgrep, args, signal, (line) => {
      if (filesOnly) {
        const filePath = line.replace(/\r$/, "").trim();
        if (!filePath) return LineOutcome.Continue;
        matchCount++;
        if (!countOnly) matchedPaths.push(formatPath(filePath));
      } else {
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return LineOutcome.Continue;
        }
        if (event.type !== "match") return LineOutcome.Continue;
        matchCount++;
        const filePath = event.data?.path?.text;
        const lineNumber = event.data?.line_number;
        const lineText = event.data?.lines?.text;
        if (!countOnly && filePath && typeof lineNumber === "number") {
          matches.push({ filePath, lineNumber, lineText });
        }
      }
      return matchCount >= effectiveLimit ? LineOutcome.Stop : LineOutcome.Continue;
    });

    if (!run.stoppedEarly && run.code !== 0 && run.code !== 1) {
      throw new Error(run.stderr.trim() || `ripgrep exited with code ${run.code}`);
    }
    if (countOnly) {
      return textResult(`${matchCount} ${filesOnly ? "files with matches" : "matches"}`);
    }
    if (matchCount === 0) return textResult("No matches found");

    const outputLines: string[] = [];
    let linesTruncated = false;
    if (filesOnly) {
      outputLines.push(...matchedPaths);
    } else {
      const rowsByFile = new Map<string, string[]>();
      const rowsFor = (relativePath: string) => {
        let rows = rowsByFile.get(relativePath);
        if (!rows) {
          rows = [];
          rowsByFile.set(relativePath, rows);
        }
        return rows;
      };

      for (const { filePath, lineNumber, lineText } of matches) {
        const rows = rowsFor(formatPath(filePath));
        if (contextValue === 0 && lineText !== undefined) {
          const sanitized = lineText
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "")
            .replace(/\n$/, "");
          const { text, wasTruncated } = truncateLine(sanitized);
          if (wasTruncated) linesTruncated = true;
          rows.push(`  ${lineNumber}: ${text}`);
          continue;
        }

        const lines = await getFileLines(filePath);
        if (!lines.length) {
          rows.push(`  ${lineNumber}: (unable to read file)`);
          continue;
        }
        const start =
          contextValue > 0
            ? Math.max(1, lineNumber - contextValue)
            : lineNumber;
        const end =
          contextValue > 0
            ? Math.min(lines.length, lineNumber + contextValue)
            : lineNumber;
        for (let current = start; current <= end; current++) {
          const sanitized = (lines[current - 1] ?? "").replace(/\r/g, "");
          const { text, wasTruncated } = truncateLine(sanitized);
          if (wasTruncated) linesTruncated = true;
          rows.push(
            current === lineNumber
              ? `  ${current}: ${text}`
              : `  ${current}- ${text}`,
          );
        }
      }

      // Grouping by file prints each path once; rg already emits a file's matches contiguously,
      // but the map keeps that true even if it ever interleaves.
      for (const [relativePath, rows] of rowsByFile)
        outputLines.push(relativePath, ...rows);
    }

    const notices: Notice[] = [];
    if (run.stoppedEarly) {
      notices.push({
        text: `${effectiveLimit} ${filesOnly ? "files" : "matches"} limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
        detail: ["matchLimitReached", effectiveLimit],
      });
    }
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

  return async (_toolCallId, params, signal) => {
    const {
      pattern,
      path: searchDir,
      limit,
      type,
      output,
    } = params as FindParams;

    if (signal?.aborted) throw new Error("Operation aborted");
    const fd = locateBinary("fd", ["fdfind"]);
    const searchPath = resolvePath(searchDir || ".", cwd);
    const countOnly = output === "count";
    const effectiveLimit = limit ?? DEFAULT_LIMIT;

    const args = ["--glob", "--color=never", "--hidden"];
    if (!insideGitRepository(searchPath)) args.push("--no-require-git");

    if (type) args.push("--type", FD_TYPES[type]);
    if (!countOnly) args.push("--max-results", String(effectiveLimit));

    // fd --glob matches against the basename unless --full-path is set; in --full-path
    // mode it matches against the absolute candidate path, so a path-containing
    // pattern like 'src/**/*.spec.ts' needs a leading '**/' to match anything.
    let effectivePattern = pattern;
    if (pattern.includes("/")) {
      args.push("--full-path");
      if (
        !pattern.startsWith("/") &&
        !pattern.startsWith("**/") &&
        pattern !== "**"
      ) {
        effectivePattern = `**/${pattern}`;
      }
    }
    args.push("--", effectivePattern, searchPath);

    const results: string[] = [];
    const run = await runLines("fd", fd, args, signal, (rawLine) => {
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

    const relativized = results.map((line) => relativizeResultPath(line, searchPath));
    const notices: Notice[] = [];
    if (relativized.length >= effectiveLimit) {
      notices.push({
        text: `${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
        detail: ["resultLimitReached", effectiveLimit],
      });
    }
    return searchResult(groupByDirectory(relativized), notices);
  };
}

const LineOutcome = { Continue: "continue", Stop: "stop" } as const;
type LineOutcome = (typeof LineOutcome)[keyof typeof LineOutcome];

interface RunOutcome {
  code: number | null;
  stderr: string;
  stoppedEarly: boolean;
}

// Streams stdout line by line. A handler returning Stop kills the process once it has enough,
// and the caller then sees stoppedEarly instead of treating the kill as a failure.
function runLines(
  name: string,
  command: string,
  args: string[],
  signal: AbortSignal | undefined,
  onLine: (line: string) => LineOutcome,
): Promise<RunOutcome> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Operation aborted"));
      return;
    }
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
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
