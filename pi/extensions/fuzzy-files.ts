import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  fuzzyFilter,
} from "@earendil-works/pi-tui";
import type {
  AutocompleteItem,
  AutocompleteProvider,
} from "@earendil-works/pi-tui";
import { createLineSplitter } from "./lib/lines.ts";

// Keeps a scan of a home directory bounded; a project tree stays far below it.
const MAX_SCANNED_ENTRIES = 200_000;
const MENTION = /(?:^|\s)@([^\s"]*)$/;
const FD_ARGS = [
  "--type",
  "f",
  "--type",
  "d",
  "--hidden",
  "--follow",
  "--exclude",
  ".git",
  "--strip-cwd-prefix",
  "--max-results",
  String(MAX_SCANNED_ENTRIES),
];
// What fits in the autocomplete popup.
const MAX_SUGGESTIONS = 20;
// A rescan after this long picks up new files without rescanning on every keystroke.
const STALE_MS = 10_000;
// Bounds a scan of a huge tree; the previous result stays in use.
const SCAN_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, context) => {
    if (!context.hasUI) return;

    const fd = await resolveBinary(pi, [
      join(homedir(), ".pi", "agent", "bin", "fd"),
      "fd",
      "fdfind",
    ]);
    if (!fd) return;

    const rank = (await resolveBinary(pi, ["fzf"]))
      ? rankWithFzf
      : rankInProcess;
    const getEntries = createEntryLoader(pi, fd, context.cwd);
    void getEntries();

    context.ui.addAutocompleteProvider((current) =>
      createProvider(current, getEntries, rank),
    );
  });
}

async function resolveBinary(
  pi: ExtensionAPI,
  candidates: readonly string[],
): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (candidate.includes("/") && !existsSync(candidate)) continue;
    const { code } = await pi.exec(candidate, ["--version"], {
      timeout: PROBE_TIMEOUT_MS,
    });
    if (code === 0) return candidate;
  }
  return undefined;
}

function createEntryLoader(
  pi: ExtensionAPI,
  fd: string,
  cwd: string,
): () => Promise<string[]> {
  let paths: string[] = [];
  let scannedAt = 0;
  let scan: Promise<void> | undefined;

  const rescan = () => {
    scan ??= (async () => {
      const { stdout, code } = await pi.exec(fd, FD_ARGS, {
        cwd,
        timeout: SCAN_TIMEOUT_MS,
      });
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

function createProvider(
  current: AutocompleteProvider,
  getEntries: () => Promise<string[]>,
  rank: Rank,
): AutocompleteProvider {
  return {
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const delegate = () =>
        current.getSuggestions(lines, cursorLine, cursorCol, options);
      const query = MENTION.exec((lines[cursorLine] ?? "").slice(0, cursorCol))?.[1];
      // Home and absolute paths keep the built-in directory listing, which avoids scanning $HOME.
      if (query === undefined || query.startsWith("~") || query.startsWith("/"))
        return delegate();

      const paths = await getEntries();
      // eslint-disable-next-line unicorn/no-null -- pi's autocomplete API treats null as "no suggestions"
      if (options.signal.aborted) return null;
      if (paths.length === 0) return delegate();

      const ranked = await rank(paths, query, options.signal);
      // eslint-disable-next-line unicorn/no-null, @typescript-eslint/no-unnecessary-condition -- pi's autocomplete API treats null as "no suggestions"; the signal can abort while rank awaits
      if (options.signal.aborted || ranked.length === 0) return null;

      return { items: ranked.map(toItem), prefix: `@${query}` };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(
        lines,
        cursorLine,
        cursorCol,
        item,
        prefix,
      );
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return (
        current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ??
        true
      );
    },
  };
}

type Rank = (
  paths: readonly string[],
  query: string,
  signal: AbortSignal,
) => Promise<string[]>;

function rankWithFzf(
  paths: readonly string[],
  query: string,
  signal: AbortSignal,
): Promise<string[]> {
  if (!query) return Promise.resolve(paths.slice(0, MAX_SUGGESTIONS));
  // An already-aborted signal never fires "abort" for a listener attached after the fact,
  // so this has to be checked upfront rather than relying on the listener below.
  if (signal.aborted) return Promise.resolve([]);

  return new Promise((resolve) => {
    const child = spawn("fzf", ["--filter", query], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    const matches: string[] = [];
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
    // matches and killing it once we have enough is what keeps broad queries cheap. A few
    // extra buffered lines may still reach onLine after finish() settles; finish() is a
    // no-op past the first call, so that is harmless.
    const splitter = createLineSplitter((line) => {
      if (line) matches.push(line);
      if (matches.length >= MAX_SUGGESTIONS) finish();
    });
    child.stdout.on("data", (chunk: string) => splitter.push(chunk));
    child.on("error", finish);
    child.on("close", finish);
    child.stdin.on("error", () => {});
    child.stdin.end(`${paths.join("\n")}\n`);
  });
}

async function rankInProcess(
  paths: readonly string[],
  query: string,
): Promise<string[]> {
  return fuzzyFilter([...paths], query, (path) => path).slice(0, MAX_SUGGESTIONS);
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
