import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { serialize } from "./ui-queue.ts";

export async function confirm(
  ctx: ExtensionContext,
  title: string,
  body?: string,
): Promise<boolean> {
  if (!ctx.hasUI) return false;
  return await serialize(() => ctx.ui.confirm(title, body ?? ""));
}
