import { isRecord } from "./untyped.ts";

export interface SessionEntry {
  slug: string;
  updated_at: string;
  active: boolean;
}

// tuicr's JSON field names. comment_type stays open: tuicr may add types this extension
// does not know yet, and they are shown as they are.
export interface TuicrComment {
  id: string;
  location: string;
  path: string | undefined;
  side: "old" | "new" | undefined;
  comment_type: string;
  content: string;
}

export function parseSessionEntries(value: unknown): SessionEntry[] {
  if (!Array.isArray(value)) throw new Error("tuicr listed its sessions in an unexpected format.");
  return value.map((item: unknown) => {
    if (!isRecord(item) || typeof item.slug !== "string" || typeof item.updated_at !== "string" || typeof item.active !== "boolean") {
      throw new Error("tuicr listed a session in an unexpected format.");
    }
    return { slug: item.slug, updated_at: item.updated_at, active: item.active };
  });
}

export function parseComment(value: unknown): TuicrComment {
  if (!isRecord(value)) throw new Error("tuicr returned a comment in an unexpected format.");
  const { id, location, path, side, comment_type, content } = value;
  if (typeof id !== "string" || typeof location !== "string" || typeof comment_type !== "string" || typeof content !== "string") {
    throw new Error("tuicr returned a comment in an unexpected format.");
  }
  return {
    id,
    location,
    path: typeof path === "string" ? path : undefined,
    side: side === "old" || side === "new" ? side : undefined,
    comment_type,
    content,
  };
}

// The session tuicr just opened is an active one that was not active before the
// launch. Re-reviewing the same target reuses the same slug, so the path cannot
// tell old from new. Ties go to the most recently updated entry.
export function pickNewSession(
  entries: readonly SessionEntry[],
  activeBefore: ReadonlySet<string>,
): SessionEntry | undefined {
  return entries
    .filter((entry) => entry.active && !activeBefore.has(entry.slug))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
}

export function activeSlugs(entries: readonly SessionEntry[]): Set<string> {
  return new Set(entries.filter((entry) => entry.active).map((entry) => entry.slug));
}

export function unseenComments(
  comments: readonly TuicrComment[],
  seen: ReadonlySet<string>,
): TuicrComment[] {
  return comments.filter((comment) => !seen.has(comment.id));
}

export interface QuietState {
  count: number;
  since: number;
}

// Tracks when the set of unseen comments last grew. The wait tool returns once
// `quietMs` has passed since that moment.
export function advanceQuiet(
  previous: QuietState | undefined,
  unseenCount: number,
  now: number,
): QuietState | undefined {
  if (unseenCount === 0) return undefined;
  if (previous && previous.count === unseenCount) return previous;
  return { count: unseenCount, since: now };
}

export function quietElapsed(
  state: QuietState | undefined,
  now: number,
  quietMs: number,
): boolean {
  return state !== undefined && now - state.since >= quietMs;
}

export function formatComments(comments: readonly TuicrComment[]): string {
  if (comments.length === 0) return "No comments.";
  return comments.map(formatComment).join("\n\n");
}

// Mirrors the crit skill's reading of comment types so the agent treats them
// the same way: issue = fix, suggestion = consider, note = acknowledge, praise = none.
function formatComment(comment: TuicrComment): string {
  const { location, path, side, comment_type, content } = comment;
  const where = path ? `${location}${side === "old" ? " (old side)" : ""}` : "review-level";
  const type = comment_type === "none" ? "" : `[${comment_type}] `;
  return `- ${type}${where}\n  ${content.replace(/\n/g, "\n  ")}`;
}
