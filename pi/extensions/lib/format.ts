import { homedir } from "node:os";
import { sep } from "node:path";

export function shortenPath(path: string): string {
  const home = homedir();
  if (path !== home && !path.startsWith(`${home}${sep}`)) return path;
  return `~${path.slice(home.length)}`;
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
