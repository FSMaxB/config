import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { cwdSlug, planPathIn } from "./plan-naming.ts";
import { contains } from "./repo.ts";

// Plan files live under the agent's plans directory, one subdirectory per working
// directory. plan_path hands a fresh path to the model, which then owns it: nothing here
// remembers which file the current plan is, so every consumer takes the path explicitly.
export function newPlanPath(slug: string): string {
  return planPathIn(plansDirectory(), slug);
}

export function plansDirectory(): string {
  return join(getAgentDir(), "plans", cwdSlug(process.cwd()));
}

// Relative paths are resolved against the process cwd, the same base the file tools use.
export function isInPlansDirectory(path: string): boolean {
  return contains(plansDirectory(), resolve(path));
}
