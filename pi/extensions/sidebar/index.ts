import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type OverlayHandle, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { MIN_TERMINAL_WIDTH, type PanelSection, SidebarPanel, type TextMeasure } from "./panel.ts";
import type { SidebarSection } from "./section.ts";
import { createSkillsSection } from "./skills-section.ts";
import { defaultVisibility, sessionVisibility, VISIBILITY_ENTRY, Visibility } from "./visibility.ts";

const measure: TextMeasure = {
  width: visibleWidth,
  truncate: (text, maxWidth, ellipsis) => truncateToWidth(text, maxWidth, ellipsis),
};

type Overlay = { handle?: OverlayHandle; requestRender(): void };

export default function sidebarExtension(pi: ExtensionAPI) {
  let visibility: Visibility = Visibility.On;
  let overlay: Overlay | undefined;

  // State lives in this closure, not at module level: pi re-runs the factory for new sessions.
  const sections: readonly SidebarSection[] = [createSkillsSection(pi, redraw)];

  pi.on("session_start", async (_event, context) => restore(context));
  pi.on("session_tree", async (_event, context) => restore(context));
  pi.on("session_shutdown", async () => {
    overlay?.handle?.hide();
    overlay = undefined;
  });

  pi.registerCommand("sidebar", {
    description: "Show or hide the sidebar for this session",
    handler: async (args, context) => {
      const argument = args.trim().toLowerCase();
      if (argument === "") return setVisibility(visibility === Visibility.On ? Visibility.Off : Visibility.On, context);
      if (argument === "on") return setVisibility(Visibility.On, context);
      if (argument === "off") return setVisibility(Visibility.Off, context);
      context.ui.notify("Usage: /sidebar [on|off]. Persistent default: sidebar.enabled in settings.json", "warning");
    },
  });

  function restore(context: ExtensionContext): void {
    for (const section of sections) section.restore(context);
    const branch = context.sessionManager.getBranch();
    visibility = sessionVisibility(branch) ?? defaultVisibility(pi.getSettings());
    redraw(context);
  }

  function setVisibility(next: Visibility, context: ExtensionContext): void {
    visibility = next;
    pi.appendEntry(VISIBILITY_ENTRY, { enabled: next === Visibility.On });
    redraw(context);
    const pending = next === Visibility.On && visibleSections().length === 0 ? " (shows once it has content)" : "";
    context.ui.notify(`Sidebar ${next}${pending}`, "info");
  }

  function redraw(context: ExtensionContext): void {
    if (!context.hasUI) return;
    if (visibility === Visibility.Off || visibleSections().length === 0) {
      overlay?.handle?.setHidden(true);
      return;
    }
    if (overlay) {
      overlay.handle?.setHidden(false);
      overlay.requestRender();
      return;
    }
    overlay = openOverlay(context);
  }

  function visibleSections(): PanelSection[] {
    return sections
      .map((section) => ({ title: section.title, items: section.items() }))
      .filter((section) => section.items.length > 0);
  }

  function openOverlay(context: ExtensionContext): Overlay {
    const state: Overlay = { requestRender: () => {} };
    // pi counts an open ui.custom call as a pending prompt and reports no prompt nested inside it, so an
    // overlay kept open through ui.custom silenced notify-ask for the rest of the session. ui.custom is the
    // only way to reach the TUI: the panel is shown with tui.showOverlay, and done() runs before the
    // factory returns, which makes pi skip its own overlay and settle the call right away.
    void context.ui.custom<void>((tui, theme, _keybindings, done) => {
      const panel = new SidebarPanel(theme, measure, visibleSections);
      state.requestRender = () => tui.requestRender();
      state.handle = tui.showOverlay(panel, {
        nonCapturing: true,
        anchor: "top-right",
        // pi-tui keeps this object and reads `width` on every render, so a getter lets the box follow
        // its content.
        get width() {
          return panel.width(tui.terminal.columns);
        },
        margin: { top: 1, right: 1 },
        visible: (termWidth: number) => termWidth >= MIN_TERMINAL_WIDTH,
      });
      done();
      return panel;
    });
    return state;
  }
}
