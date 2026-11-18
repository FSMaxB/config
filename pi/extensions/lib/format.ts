import { homedir } from "node:os";
import { sep } from "node:path";
import { MILLISECONDS_PER_SECOND, MINUTES_PER_HOUR, SECONDS_PER_MINUTE } from "./units.ts";

export function shortenPath(path: string, home: string = homedir()): string {
  if (path !== home && !path.startsWith(`${home}${sep}`)) return path;
  return `~${path.slice(home.length)}`;
}

export function formatDuration(milliseconds: number): string {
  const seconds = milliseconds / MILLISECONDS_PER_SECOND;
  if (seconds < SECONDS_PER_MINUTE) return `${seconds.toFixed(1)}s`;
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  const remainder = totalSeconds % SECONDS_PER_MINUTE;
  if (minutes < MINUTES_PER_HOUR) return `${minutes}m ${remainder}s`;
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  return `${hours}h ${minutes % MINUTES_PER_HOUR}m`;
}

// Allowlist filter for text that leaves the terminal (session names, desktop
// notifications): only letters, digits, whitespace and ,.!? survive.
export function sanitizeDisplayText(raw: string, maxLength: number): string {
  // The filter keeps no combining marks or joiners, so a code point is one visible character.
  return Array.from(
    raw
      .replace(/[^\p{L}\p{N}\s.,!?]/gu, "")
      .replace(/\s+/g, " ")
      .trim(),
  )
    .slice(0, maxLength)
    .join("")
    .trim();
}
