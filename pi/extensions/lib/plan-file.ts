import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// The plan file the current plan-mode session owns. write_plan creates it and then keeps
// overwriting it; the repo scope guard treats it as the one writable path outside the repo.
let currentPlanPath: string | undefined;

export function getCurrentPlanPath(): string | undefined {
	return currentPlanPath;
}

export function setCurrentPlanPath(path: string | undefined): void {
	currentPlanPath = path;
}

export function plansDirectory(): string {
	return join(getAgentDir(), "plans", cwdSlug());
}

export function planFileName(title: string): string {
	return `${timestamp()}-${slugify(title)}.md`;
}

function cwdSlug(): string {
	return process.cwd().replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function timestamp(): string {
	const now = new Date();
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function slugify(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 60);
	return slug || "plan";
}
