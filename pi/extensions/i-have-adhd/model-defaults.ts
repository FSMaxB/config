import type { Api, Model } from "@earendil-works/pi-ai";
import { isLocalModel, type SubagentModelConfig } from "../subagent/model-policy.ts";

const MISTRAL_MODEL_FAMILIES = /mistral|magistral|devstral|codestral|ministral|pixtral/i;

export function isOffByDefaultModel(
  model: Model<Api> | undefined,
  policyConfig: SubagentModelConfig,
): boolean {
  if (!model) return false;
  return (
    isLocalModel(model, policyConfig) ||
    /haiku/i.test(model.id) ||
    /^gpt-.*luna/i.test(model.id) ||
    MISTRAL_MODEL_FAMILIES.test(model.id)
  );
}
