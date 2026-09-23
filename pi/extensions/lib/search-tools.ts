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

  return (_toolCallId, params, signal) =>
    new Promise((resolve, reject) => {
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

      if (signal?.aborted) {
        reject(new Error("Operation aborted"));
        return;
      }

      let settled = false;
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        finish();
      };

      void (async () => {
        try {
          const ripgrep = locateBinary("rg");
          const searchPath = resolvePath(searchDir || ".", cwd);

          let isDirectory: boolean;
          try {
            isDirectory = (await stat(searchPath)).isDirectory();
          } catch {
            settle(() => reject(new Error(`Path not found: ${searchPath}`)));
            return;
          }

          const contextValue = context && context > 0 ? context : 0;
          const countOnly = output === "count";
          const effectiveLimit = countOnly
            ? undefined
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

          const child = spawn(ripgrep, args, {
            stdio: ["ignore", "pipe", "pipe"],
          });
          const lineReader = createInterface({ input: child.stdout });

          let stderrText = "";
          let matchCount = 0;
          let matchLimitReached = false;
          let linesTruncated = false;
          let aborted = false;
          let killedDueToLimit = false;

          const onAbort = () => {
            aborted = true;
            stopChild();
          };
          const stopChild = (dueToLimit = false) => {
            if (!child.killed) {
              killedDueToLimit = dueToLimit;
              child.kill();
            }
          };
          const cleanup = () => {
            lineReader.close();
            signal?.removeEventListener("abort", onAbort);
          };
          signal?.addEventListener("abort", onAbort, { once: true });

          child.stderr?.on("data", (chunk) => {
            stderrText += chunk.toString();
          });

          const matchedPaths = countOnly ? undefined : ([] as string[]);
          const matches = countOnly
            ? undefined
            : ([] as {
                filePath: string;
                lineNumber: number;
                lineText?: string;
              }[]);

          lineReader.on("line", (line) => {
            if (!countOnly && matchCount >= effectiveLimit!) return;

            if (filesOnly) {
              const filePath = line.replace(/\r$/, "").trim();
              if (!filePath) return;
              matchCount++;
              matchedPaths?.push(formatPath(filePath));
            } else {
              if (!line.trim()) return;
              let event: any;
              try {
                event = JSON.parse(line);
              } catch {
                return;
              }
              if (event.type !== "match") return;
              matchCount++;
              const filePath = event.data?.path?.text;
              const lineNumber = event.data?.line_number;
              const lineText = event.data?.lines?.text;
              if (filePath && typeof lineNumber === "number") {
                matches?.push({ filePath, lineNumber, lineText });
              }
            }

            if (!countOnly && matchCount >= effectiveLimit!) {
              matchLimitReached = true;
              stopChild(true);
            }
          });

          child.on("error", (error) => {
            cleanup();
            settle(() =>
              reject(new Error(`Failed to run ripgrep: ${error.message}`)),
            );
          });

          child.on("close", async (code) => {
            cleanup();
            if (aborted) {
              settle(() => reject(new Error("Operation aborted")));
              return;
            }
            if (!killedDueToLimit && code !== 0 && code !== 1) {
              const message =
                stderrText.trim() || `ripgrep exited with code ${code}`;
              settle(() => reject(new Error(message)));
              return;
            }
            if (countOnly) {
              settle(() =>
                resolve({
                  content: [
                    {
                      type: "text",
                      text: `${matchCount} ${filesOnly ? "files with matches" : "matches"}`,
                    },
                  ],
                  details: undefined,
                }),
              );
              return;
            }
            if (matchCount === 0) {
              settle(() =>
                resolve({
                  content: [{ type: "text", text: "No matches found" }],
                  details: undefined,
                }),
              );
              return;
            }

            const outputLines: string[] = [];
            if (filesOnly) {
              outputLines.push(...matchedPaths!);
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

              for (const { filePath, lineNumber, lineText } of matches!) {
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
                  const sanitized = (lines[current - 1] ?? "").replace(
                    /\r/g,
                    "",
                  );
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

            // The match limit already caps the row count, so only the byte limit applies here.
            const truncation = truncateHead(outputLines.join("\n"), {
              maxLines: Number.MAX_SAFE_INTEGER,
            });
            let output = truncation.content;
            const details: Record<string, unknown> = {};
            const notices: string[] = [];

            if (matchLimitReached) {
              notices.push(
                `${effectiveLimit} ${filesOnly ? "files" : "matches"} limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
              );
              details.matchLimitReached = effectiveLimit;
            }
            if (truncation.truncated) {
              notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
              details.truncation = truncation;
            }
            if (linesTruncated) {
              notices.push(
                `Some lines truncated to ${MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
              );
              details.linesTruncated = true;
            }
            if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

            settle(() =>
              resolve({
                content: [{ type: "text", text: output }],
                details: Object.keys(details).length > 0 ? details : undefined,
              }),
            );
          });
        } catch (error) {
          settle(() => reject(error));
        }
      })();
    });
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

  return (_toolCallId, params, signal) =>
    new Promise((resolve, reject) => {
      const {
        pattern,
        path: searchDir,
        limit,
        type,
        output,
      } = params as FindParams;

      if (signal?.aborted) {
        reject(new Error("Operation aborted"));
        return;
      }

      let settled = false;
      let stopChild: (() => void) | undefined;
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        stopChild = undefined;
        finish();
      };
      const onAbort = () => {
        stopChild?.();
        settle(() => reject(new Error("Operation aborted")));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      void (async () => {
        try {
          const fd = locateBinary("fd", ["fdfind"]);
          const searchPath = resolvePath(searchDir || ".", cwd);
          const countOnly = output === "count";
          const effectiveLimit = countOnly
            ? undefined
            : (limit ?? DEFAULT_LIMIT);

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

          const child = spawn(fd, args, { stdio: ["ignore", "pipe", "pipe"] });
          const lineReader = createInterface({ input: child.stdout });

          let stderrText = "";
          let resultCount = 0;
          let hasOutput = false;
          const lines: string[] = [];

          stopChild = () => {
            if (!child.killed) child.kill();
          };

          child.stderr?.on("data", (chunk) => {
            stderrText += chunk.toString();
          });
          lineReader.on("line", (line) => {
            if (countOnly) {
              if (line.replace(/\r$/, "").trim()) {
                resultCount++;
                hasOutput = true;
              }
              return;
            }
            lines.push(line);
          });

          child.on("error", (error) => {
            lineReader.close();
            settle(() =>
              reject(new Error(`Failed to run fd: ${error.message}`)),
            );
          });

          child.on("close", (code) => {
            lineReader.close();
            if (signal?.aborted) {
              settle(() => reject(new Error("Operation aborted")));
              return;
            }

            const rawOutput = lines.join("\n");
            if (code !== 0 && !(countOnly ? hasOutput : rawOutput)) {
              const message =
                stderrText.trim() || `fd exited with code ${code}`;
              settle(() => reject(new Error(message)));
              return;
            }
            if (countOnly) {
              settle(() =>
                resolve({
                  content: [
                    { type: "text", text: `${resultCount} matching entries` },
                  ],
                  details: undefined,
                }),
              );
              return;
            }
            if (!rawOutput) {
              settle(() =>
                resolve({
                  content: [
                    { type: "text", text: "No files found matching pattern" },
                  ],
                  details: undefined,
                }),
              );
              return;
            }

            const relativized: string[] = [];
            for (const rawLine of lines) {
              const line = rawLine.replace(/\r$/, "").trim();
              if (!line) continue;
              relativized.push(relativizeResultPath(line, searchPath));
            }

            const resultLimitReached = relativized.length >= effectiveLimit;
            const truncation = truncateHead(groupByDirectory(relativized), {
              maxLines: Number.MAX_SAFE_INTEGER,
            });
            let resultOutput = truncation.content;
            const details: Record<string, unknown> = {};
            const notices: string[] = [];

            if (resultLimitReached) {
              notices.push(
                `${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
              );
              details.resultLimitReached = effectiveLimit;
            }
            if (truncation.truncated) {
              notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
              details.truncation = truncation;
            }
            if (notices.length > 0)
              resultOutput += `\n\n[${notices.join(". ")}]`;

            settle(() =>
              resolve({
                content: [{ type: "text", text: resultOutput }],
                details: Object.keys(details).length > 0 ? details : undefined,
              }),
            );
          });
        } catch (error) {
          if (signal?.aborted) {
            settle(() => reject(new Error("Operation aborted")));
            return;
          }
          settle(() => reject(error));
        }
      })();
    });
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
  return { content: [{ type: "text", text: `${entryCount} entries` }], details: undefined };
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
