import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** One block of the sidebar. A section with no items is not drawn. */
export interface SidebarSection {
  readonly title: string;
  /** Rebuild state from the session branch (session start, /tree navigation). */
  restore(context: ExtensionContext): void;
  /** Plain-text rows, already in display order. */
  items(): readonly string[];
}

/** Sections call this when their items changed outside of `restore`. */
export type SectionChanged = (context: ExtensionContext) => void;

export type BranchEntry = { type: string; customType?: string; data?: unknown };
