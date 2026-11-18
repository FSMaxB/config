import { basename, extname, sep } from "node:path";
import { ItemTone } from "./panel.ts";
import type { PanelItem } from "./panel.ts";
import type { BranchEntry } from "./section.ts";
import { resolveToolPath, safeRealPath } from "./tool-path.ts";
import type { RealPath } from "./tool-path.ts";
import { isRecord, stringProperty } from "../lib/untyped.ts";

export const LOADED_PLAN_ENTRY = "loaded-plan";

/** `path` is the realpath of the plan file. */
export interface LoadedPlanData { path: string }

/** The plan a successful read, write or edit of `rawPath` touched: a Markdown file under `plansRoot`. */
export function planPathForToolPath(
  plansRoot: string,
  rawPath: unknown,
  cwd: string,
  realPath: RealPath = safeRealPath,
): string | undefined {
  if (typeof rawPath !== "string" || rawPath === "") return undefined;
  const path = realPath(resolveToolPath(rawPath, cwd));
  if (!path.startsWith(realPath(plansRoot) + sep) || !path.endsWith(".md")) return undefined;
  return path;
}

/** Plans recorded on the branch, in first-load order. */
export function plansOnBranch(entries: readonly BranchEntry[]): readonly string[] {
  let plans: readonly string[] = [];
  for (const entry of entries) {
    const path = planFromEntry(entry);
    if (path === undefined) continue;
    plans = withPlan(plans, path) ?? plans;
  }
  return plans;
}

/** The plans after loading `path`, or undefined when it is already listed. */
export function withPlan(plans: readonly string[], path: string): readonly string[] | undefined {
  return plans.includes(path) ? undefined : [...plans, path];
}

export function planItems(plans: readonly string[]): PanelItem[] {
  return plans.map((path) => ({ text: basename(path, extname(path)), depth: 0, tone: ItemTone.Normal }));
}

function planFromEntry(entry: BranchEntry): string | undefined {
  if (entry.type !== "custom" || entry.customType !== LOADED_PLAN_ENTRY) return undefined;
  return isRecord(entry.data) ? stringProperty(entry.data, "path") : undefined;
}
