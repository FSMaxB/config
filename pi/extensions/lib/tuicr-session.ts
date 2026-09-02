export interface SessionEntry {
  slug: string;
  kind: string;
  path: string;
  updated_at: string;
  comment_count: number;
  active: boolean;
}

export interface TuicrComment {
  id: string;
  location: string;
  path?: string;
  start_line?: number;
  end_line?: number;
  side?: string;
  comment_type: string;
  lifecycle_state: string;
  content: string;
}

// The session tuicr just opened is an active one that was not active before the
// launch. Re-reviewing the same target reuses the same slug, so the path cannot
// tell old from new. Ties go to the most recently updated entry.
export function pickNewSession(
  entries: SessionEntry[],
  activeBefore: ReadonlySet<string>,
): SessionEntry | undefined {
  return entries
    .filter((entry) => entry.active && !activeBefore.has(entry.slug))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
}

export function activeSlugs(entries: SessionEntry[]): Set<string> {
  return new Set(entries.filter((entry) => entry.active).map((entry) => entry.slug));
}

export function unseenComments(
  comments: TuicrComment[],
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

export function formatComments(comments: TuicrComment[]): string {
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
