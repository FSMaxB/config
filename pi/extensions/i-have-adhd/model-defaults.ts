import type { Api, Model } from "@earendil-works/pi-ai";
import { isLocalModel, type SubagentModelConfig } from "../subagent/model-policy.ts";

export function isOffByDefaultModel(
  model: Model<Api> | undefined,
  policyConfig: SubagentModelConfig,
): boolean {
  if (!model) return false;
  return (
    isLocalModel(model, policyConfig) ||
    /haiku/i.test(model.id) ||
    /^gpt-.*luna/i.test(model.id)
  );
}
