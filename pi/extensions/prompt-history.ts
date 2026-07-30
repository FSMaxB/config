/**
 * Backfills the editor's arrow-up prompt history with user prompts from
 * previous sessions of the same project, mined from the session JSONL files
 * pi already stores. No separate history file is written.
 */
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_PROMPTS = 50;
const MAX_SESSION_FILES = 10;

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (event, context) => {
    // Only on process startup: session_start fires before pi populates the
    // editor history from a resumed session, so swapping the editor here
    // loses nothing and resumed prompts land on top of the backfill. Later
    // reasons (new/resume/fork) keep the already-installed editor, whose
    // history persists across in-app session switches.
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
    context.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = new CustomEditor(tui, theme, keybindings);
      for (const prompt of prompts) {
        editor.addToHistory(prompt);
      }
      return editor;
    });
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
  const sessionFiles = fileNames
    .filter((name) => name.endsWith(".jsonl") && name !== currentFileName)
    .sort()
    .reverse()
    .slice(0, MAX_SESSION_FILES);

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
