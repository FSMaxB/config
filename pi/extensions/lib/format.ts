import { homedir } from "node:os";
import { sep } from "node:path";

export function shortenPath(path: string): string {
  const home = homedir();
  if (path !== home && !path.startsWith(`${home}${sep}`)) return path;
  return `~${path.slice(home.length)}`;
}

export function formatDuration(milliseconds: number): string {
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

// Allowlist filter for text that leaves the terminal (session names, desktop
// notifications): only letters, digits, whitespace and ,.!? survive.
export function sanitizeDisplayText(raw: string, maxLength: number): string {
  return [
    ...raw
      .replace(/[^\p{L}\p{N}\s.,!?]/gu, "")
      .replace(/\s+/g, " ")
      .trim(),
  ]
    .slice(0, maxLength)
    .join("")
    .trim();
}
