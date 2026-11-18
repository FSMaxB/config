import type { BranchEntry } from "./section.ts";
import { isRecord } from "../lib/untyped.ts";

export const VISIBILITY_ENTRY = "sidebar-visibility";

export interface VisibilityData { enabled: boolean }

export const Visibility = { On: "on", Off: "off" } as const;
export type Visibility = (typeof Visibility)[keyof typeof Visibility];

/** Latest session toggle on the branch, or undefined when the session never toggled. */
export function sessionVisibility(entries: readonly BranchEntry[]): Visibility | undefined {
  let visibility: Visibility | undefined;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== VISIBILITY_ENTRY) continue;
    const enabled = isRecord(entry.data) ? entry.data.enabled : undefined;
    if (typeof enabled === "boolean") visibility = enabled ? Visibility.On : Visibility.Off;
  }
  return visibility;
}

export function defaultVisibility(settings: object): Visibility {
  const sidebar: unknown = Reflect.get(settings, "sidebar");
  return isRecord(sidebar) && sidebar.enabled === false ? Visibility.Off : Visibility.On;
}
