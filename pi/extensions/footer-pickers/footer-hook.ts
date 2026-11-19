import { FooterComponent } from "@earendil-works/pi-coding-agent";
import type { ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

// pi's FooterComponent has no click hooks and extensions cannot reach the built-in instance, so
// handleMouse goes onto the prototype pi exports. pi re-runs extension factories for new sessions
// but keeps this module, so the handler is module state that each run replaces.
let currentHandler: FooterClickHandler | undefined;
const PATCH_MARKER = Symbol.for("config.footer-pickers.patched");

export function installFooterClickHandler(handler: FooterClickHandler): InstallOutcome {
  const prototype: object = FooterComponent.prototype;
  const patched = Reflect.get(prototype, PATCH_MARKER) === true;
  if (!patched && Reflect.get(prototype, "handleMouse") !== undefined) return "conflict";

  currentHandler = handler;
  // Redefined on every install, so a re-evaluated copy of this module wins with its own handler.
  Object.defineProperty(prototype, "handleMouse", { configurable: true, writable: true, value: handleFooterMouse });
  Reflect.set(prototype, PATCH_MARKER, true);
  return "installed";
}

function handleFooterMouse(this: FooterComponent, event: TuiMouseEvent): TuiMouseEventResult | undefined {
  if (event.type !== "click" || event.button !== "left" || !currentHandler) return undefined;
  const view: FooterView = { lines: this.render(event.width), statuses: extensionStatuses(this) };
  return currentHandler(view, event.x, event.y) === "handled" ? { handled: true } : undefined;
}

function extensionStatuses(footer: FooterComponent): ReadonlyMap<string, string> {
  const footerData: unknown = Reflect.get(footer, "footerData");
  return isFooterDataProvider(footerData) ? footerData.getExtensionStatuses() : new Map();
}

function isFooterDataProvider(value: unknown): value is ReadonlyFooterDataProvider {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "getExtensionStatuses") === "function";
}

export type FooterClickHandler = (view: FooterView, column: number, row: number) => ClickOutcome;
export type ClickOutcome = "handled" | "ignored";
export type InstallOutcome = "installed" | "conflict";

export interface FooterView {
  lines: readonly string[];
  statuses: ReadonlyMap<string, string>;
}
