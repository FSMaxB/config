import { join } from "node:path";

// The slug is reduced to [a-z0-9-] before it becomes a filename, so a slug like "../x" or
// "/etc/passwd" can never leave the directory it is joined onto.
export function planPathIn(directory: string, slug: string): string {
  return join(directory, `${timestamp()}-${slugify(slug)}.md`);
}

export function cwdSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function timestamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function slugify(slug: string): string {
  const cleaned = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return cleaned || "plan";
}
