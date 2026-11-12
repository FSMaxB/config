import type { BranchEntry } from "./section.ts";

export const VISIBILITY_ENTRY = "sidebar-visibility";

export type VisibilityData = { enabled: boolean };

export const Visibility = { On: "on", Off: "off" } as const;
export type Visibility = (typeof Visibility)[keyof typeof Visibility];

/** Latest session toggle on the branch, or undefined when the session never toggled. */
export function sessionVisibility(entries: readonly BranchEntry[]): Visibility | undefined {
  let visibility: Visibility | undefined;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== VISIBILITY_ENTRY) continue;
    const enabled = (entry.data as Partial<VisibilityData> | undefined)?.enabled;
    if (typeof enabled === "boolean") visibility = enabled ? Visibility.On : Visibility.Off;
  }
  return visibility;
}

export function defaultVisibility(settings: object): Visibility {
  const { sidebar } = settings as { sidebar?: { enabled?: unknown } };
  return sidebar?.enabled === false ? Visibility.Off : Visibility.On;
}
