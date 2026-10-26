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
    isHaikuBefore5_5(model.id) ||
    /^gpt-.*luna/i.test(model.id) ||
    MISTRAL_MODEL_FAMILIES.test(model.id)
  );
}

/**
 * Ids without a version after `haiku` (such as the older `claude-3-5-haiku-20241022`) count as
 * older. Version parts are at most two digits so a date suffix is not mistaken for one.
 */
function isHaikuBefore5_5(modelId: string): boolean {
  if (!/haiku/i.test(modelId)) return false;
  const match = /haiku-(\d{1,2})(?!\d)(?:[-.](\d{1,2})(?!\d))?/i.exec(modelId);
  if (!match) return true;
  const [, major, minor = "0"] = match;
  return Number(major) < 5 || (Number(major) === 5 && Number(minor) < 5);
}
