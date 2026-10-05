import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PLAN_PATH = "plan_path";
export const SUBMIT_PLAN = "submit_plan";
export const PLAN_TOOLS = [PLAN_PATH, SUBMIT_PLAN];

// Sessions saved while plan mode was off may restore a loadout without the planning tools.
// Only missing ones are appended, so unrelated tools keep their order.
export function activateMissingPlanTools(pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">): void {
  const active = pi.getActiveTools();
  const missing = PLAN_TOOLS.filter((name) => !active.includes(name));
  if (missing.length > 0) pi.setActiveTools([...active, ...missing]);
}
