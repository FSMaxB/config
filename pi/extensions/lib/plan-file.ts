import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { cwdSlug, planPathIn } from "./plan-naming.ts";

// Plan files live under the agent's plans directory, one subdirectory per working
// directory. plan_path hands a fresh path to the model, which then owns it: nothing here
// remembers which file the current plan is, so every consumer takes the path explicitly.
export function newPlanPath(slug: string): string {
  return planPathIn(plansDirectory(), slug);
}

export function plansDirectory(): string {
  return join(getAgentDir(), "plans", cwdSlug(process.cwd()));
}
