import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { plansRoot } from "../lib/plan-file.ts";
import {
  LOADED_PLAN_ENTRY,
  planItems,
  planPathForToolPath,
  plansOnBranch,
  withPlan,
} from "./plans.ts";
import type {
  LoadedPlanData,
} from "./plans.ts";
import type { SectionChanged, SidebarSection } from "./section.ts";

const PLAN_TOOLS: ReadonlySet<string> = new Set(["read", "write", "edit"]);

export function createPlansSection(pi: ExtensionAPI, changed: SectionChanged): SidebarSection {
  let plans: readonly string[] = [];

  // Returning a value from a tool_result handler would replace the tool result, so this returns nothing.
  pi.on("tool_result", async (event, context) => {
    if (!PLAN_TOOLS.has(event.toolName) || event.isError) return;
    record(planPathForToolPath(plansRoot(), event.input.path, context.cwd), context);
  });

  return {
    title: "Plans",
    restore: (context) => {
      plans = plansOnBranch(context.sessionManager.getBranch());
    },
    items: () => planItems(plans),
  };

  function record(path: string | undefined, context: ExtensionContext): void {
    if (path === undefined) return;
    const next = withPlan(plans, path);
    if (next === undefined) return;
    plans = next;
    pi.appendEntry(LOADED_PLAN_ENTRY, { path } satisfies LoadedPlanData);
    changed(context);
  }
}
