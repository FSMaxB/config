/**
 * Backfills the editor's arrow-up prompt history with user prompts from
 * previous sessions of the same project, mined from the session JSONL files
 * pi already stores. No separate history file is written.
 */
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";

const MAX_PROMPTS = 50;
const MAX_SESSION_FILES = 10;

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (event, context) => {
    // Only on process startup. Later reasons (new/resume/fork) keep the
    // already-installed editor, whose history persists across in-app session
    // switches.
    if (event.reason !== "startup" || context.mode !== "tui") {
      return;
    }
    const prompts = await loadPreviousPrompts(
      context.sessionManager.getSessionDir(),
      context.sessionManager.getSessionFile(),
    );
    if (prompts.length === 0) {
      return;
    }
    installHistoryEditor(context.ui, prompts);
  });
}

/**
 * Editor-replacing extensions like pi-vim register their editor in their own
 * session_start handler, which runs after ours because settings packages load
 * after global extensions — registering here directly would get clobbered.
 * Poll until another factory shows up (or give up after a second) and wrap
 * it, so the backfill lands in whatever editor actually won. The swap
 * discards any history pi already populated from a resumed session, which is
 * why loadPreviousPrompts mines the current session's file as well.
 */
function installHistoryEditor(
  ui: ExtensionUIContext,
  prompts: string[],
  attempt = 0,
): void {
  const pollIntervalMs = 50;
  const maxAttempts = 20;
  const wrappedFactory = ui.getEditorComponent();
  if (!wrappedFactory && attempt < maxAttempts) {
    setTimeout(() => installHistoryEditor(ui, prompts, attempt + 1), pollIntervalMs);
    return;
  }
  ui.setEditorComponent((tui, theme, keybindings) => {
    const editor = wrappedFactory
      ? wrappedFactory(tui, theme, keybindings)
      : new CustomEditor(tui, theme, keybindings);
    for (const prompt of prompts) {
      editor.addToHistory?.(prompt);
    }
    return editor;
  });
}

/** Returns prompts oldest-first, so the most recent one is the first arrow-up hit. */
async function loadPreviousPrompts(
  sessionDir: string,
  currentSessionFile: string | undefined,
): Promise<string[]> {
  let fileNames: string[];
  try {
    fileNames = await readdir(sessionDir);
  } catch {
    return [];
  }
  const currentFileName = currentSessionFile && basename(currentSessionFile);
  // Filenames start with an ISO timestamp, so a lexicographic sort is chronological.
  const previousFiles = fileNames
    .filter((name) => name.endsWith(".jsonl") && name !== currentFileName)
    .sort()
    .reverse()
    .slice(0, MAX_SESSION_FILES);
  // Mine the current session's file too: the editor swap happens after pi
  // backfilled a resumed session's prompts into the previous editor instance,
  // and those must stay the freshest arrow-up hits even when newer session
  // files exist.
  const sessionFiles = currentFileName ? [currentFileName, ...previousFiles] : previousFiles;

  const newestFirst: string[] = [];
  for (const fileName of sessionFiles) {
    let content: string;
    try {
      content = await readFile(join(sessionDir, fileName), "utf8");
    } catch {
      continue;
    }
    // Within a file prompts are oldest-first; walk them newest-first and keep
    // the most recent occurrence of duplicates.
    for (const prompt of extractUserPrompts(content).reverse()) {
      if (newestFirst.length >= MAX_PROMPTS) {
        break;
      }
      if (!newestFirst.includes(prompt)) {
        newestFirst.push(prompt);
      }
    }
    if (newestFirst.length >= MAX_PROMPTS) {
      break;
    }
  }
  return newestFirst.reverse();
}

function extractUserPrompts(jsonl: string): string[] {
  const prompts: string[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "message" || entry.message?.role !== "user") {
      continue;
    }
    const text = userMessageText(entry.message.content);
    // Injected user messages (skill blocks, system reminders, forwarded tool
    // output) start with a tag; typed prompts practically never do.
    if (text && !text.startsWith("<")) {
      prompts.push(text);
    }
  }
  return prompts;
}

function userMessageText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content.trim() || undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
  return text || undefined;
}
