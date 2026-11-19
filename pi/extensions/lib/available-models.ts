import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// getAvailable() is a snapshot that an in-flight availability pass has not
// necessarily updated yet (extension providers registered on this session's
// start land in a later async pass). Refreshing first is pi's documented way to
// settle the snapshot before a synchronous read; a failed refresh just leaves
// the snapshot as it was.
export async function settledAvailableModels(context: ExtensionContext): Promise<Model<Api>[]> {
  await context.modelRegistry.refresh({ allowNetwork: false }).catch(() => undefined);
  return context.modelRegistry.getAvailable();
}
