/**
 * Model selection policy for subagents.
 *
 * The main agent picks the subagent model, but within hard limits:
 * a session on a local model may only dispatch local subagents, and a
 * session on a cloud model may only dispatch subagents from the same
 * provider family (or local ones). Guidance texts from config.json
 * steer the choice without being enforced.
 *
 * Only type-only external imports, so the module stays runnable in
 * isolation for testing.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";

export interface SubagentModelConfig {
  localProviders?: string[];
  providerGroups?: string[][];
  models?: { match: string; guidance: string }[];
}

export function loadPolicyConfig(directory: string): SubagentModelConfig {
  try {
    const parsed = JSON.parse(readFileSync(join(directory, "config.json"), "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as SubagentModelConfig) : {};
  } catch {
    return {};
  }
}

export function guidanceTable(options: {
  mainModel: Model<Api> | undefined;
  availableModels: Model<Api>[];
  config: SubagentModelConfig;
}): string {
  return candidateModels(options.mainModel, options.availableModels, options.config)
    .map((model) => {
      const guidance = guidanceFor(model, options.config);
      return guidance ? `- ${model.provider}/${model.id}: ${guidance}` : undefined;
    })
    .filter((entry): entry is string => entry !== undefined)
    .join("\n");
}

export type ModelResolution = { ok: true; model: Model<Api> | undefined } | { ok: false; error: string };

export function resolveSubagentModel(options: {
  requested: string | undefined;
  mainModel: Model<Api> | undefined;
  availableModels: Model<Api>[];
  config: SubagentModelConfig;
}): ModelResolution {
  const { requested, mainModel, availableModels, config } = options;
  if (!requested) return { ok: true, model: mainModel };

  const matches = findRequestedModels(requested, availableModels);
  if (matches.length === 0) {
    return {
      ok: false,
      error:
        `Model "${requested}" is not available. Valid subagent models:\n` +
        describeCandidates(mainModel, availableModels, config),
    };
  }
  if (matches.length > 1) {
    const qualified = matches.map((model) => `${model.provider}/${model.id}`).join(", ");
    return { ok: false, error: `Model "${requested}" is ambiguous (${qualified}). Use "provider/id".` };
  }

  const model = matches[0];
  if (mainModel && isLocalModel(mainModel, config) && !isLocalModel(model, config)) {
    return {
      ok: false,
      error:
        `The session runs on a local model (${mainModel.provider}/${mainModel.id}), so subagents must use local models too. ` +
        `Prefer omitting "model" to inherit the session model. Valid subagent models:\n` +
        describeCandidates(mainModel, availableModels, config),
    };
  }
  if (mainModel && !isLocalModel(model, config) && !sameProviderFamily(mainModel.provider, model.provider, config)) {
    return {
      ok: false,
      error:
        `Cloud subagent models must stay within the session model's provider family (${mainModel.provider}), ` +
        `but ${model.provider}/${model.id} is a different cloud provider. Valid subagent models:\n` +
        describeCandidates(mainModel, availableModels, config),
    };
  }
  return { ok: true, model };
}

function findRequestedModels(requested: string, availableModels: Model<Api>[]): Model<Api>[] {
  const exact = availableModels.filter((model) => `${model.provider}/${model.id}` === requested);
  if (exact.length > 0) return exact;
  return availableModels.filter((model) => model.id === requested);
}

function describeCandidates(
  mainModel: Model<Api> | undefined,
  availableModels: Model<Api>[],
  config: SubagentModelConfig,
): string {
  const candidates = candidateModels(mainModel, availableModels, config);
  if (candidates.length === 0) return '(none — omit "model" to inherit the session model)';
  return candidates
    .map((model) => {
      const local = isLocalModel(model, config) ? " (local)" : "";
      const guidance = guidanceFor(model, config);
      return `- ${model.provider}/${model.id}${local}${guidance ? ` — ${guidance}` : ""}`;
    })
    .join("\n");
}

function candidateModels(
  mainModel: Model<Api> | undefined,
  availableModels: Model<Api>[],
  config: SubagentModelConfig,
): Model<Api>[] {
  if (!mainModel) return availableModels;
  if (isLocalModel(mainModel, config)) {
    return availableModels.filter((model) => isLocalModel(model, config));
  }
  return availableModels.filter(
    (model) => isLocalModel(model, config) || sameProviderFamily(mainModel.provider, model.provider, config),
  );
}

function isLocalModel(model: Model<Api>, config: SubagentModelConfig): boolean {
  if (config.localProviders?.includes(model.provider)) return true;
  try {
    const host = new URL(model.baseUrl).hostname;
    return (
      host === "localhost" ||
      host === "::1" ||
      host === "[::1]" ||
      host === "0.0.0.0" ||
      /^127(\.\d{1,3}){3}$/.test(host)
    );
  } catch {
    return false;
  }
}

function sameProviderFamily(providerA: string, providerB: string, config: SubagentModelConfig): boolean {
  if (providerA === providerB) return true;
  return (config.providerGroups ?? []).some((group) => group.includes(providerA) && group.includes(providerB));
}

function guidanceFor(model: Model<Api>, config: SubagentModelConfig): string | undefined {
  const qualified = `${model.provider}/${model.id}`;
  return (config.models ?? []).find(({ match }) => matchesGlob(match, model.id) || matchesGlob(match, qualified))
    ?.guidance;
}

function matchesGlob(pattern: string, value: string): boolean {
  const regex = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);
  return regex.test(value);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
