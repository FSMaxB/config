import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { collectSessionGrants, onSessionGrantsChanged } from "../lib/session-grants.ts";
import { grantRows } from "./grants.ts";
import { ItemTone } from "./panel.ts";
import type { SectionChanged, SidebarSection } from "./section.ts";

export function createGrantsSection(pi: ExtensionAPI, changed: SectionChanged): SidebarSection {
  let rows: string[] = [];
  // The bus carries no context, so redraws use the one from the latest restore. A change announced
  // before the first restore is picked up by that restore, which collects again.
  let context: ExtensionContext | undefined;

  onSessionGrantsChanged(pi.events, () => {
    if (context === undefined) return;
    refresh();
    changed(context);
  });

  return {
    title: "Session grants",
    restore: (restored) => {
      context = restored;
      refresh();
    },
    items: () => rows.map((text) => ({ text, depth: 0, tone: ItemTone.Normal })),
  };

  function refresh(): void {
    rows = grantRows(collectSessionGrants(pi.events), homedir());
  }
}
