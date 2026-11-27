/**
 * Model selection policy for subagents.
 *
 * The main agent picks the subagent model, but within hard limits:
 * a session on a local model may only dispatch local subagents, and a
 * session on a cloud model may only dispatch subagents from the same
 * provider family (or local ones). Those limits hold unless the call sets
 * crossProvider and the user approves the model's provider. Guidance texts
 * from config.json steer the choice without being enforced.
 *
 * Only type-only external imports, so the module stays runnable in
 * isolation for testing.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { isRecord } from "../lib/untyped.ts";
import { matchesWildcard } from "../lib/wildcard.ts";

// Shared by the tool description, the guidance table and the rejection, so the model reads one rule everywhere.
export const CROSS_PROVIDER_RULE =
  "A model from another provider needs crossProvider: true, which asks the user to approve that provider; set it only when the user explicitly asked for a subagent from another provider.";

const OTHER_PROVIDERS_HEADING = `Other providers (${CROSS_PROVIDER_RULE}):`;

export function loadPolicyConfig(directory: string): SubagentModelConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(directory, "config.json"), "utf-8"));
  } catch {
    return {};
  }
  return parsePolicyConfig(parsed);
}

// Malformed entries are dropped, so one bad entry does not hide the rest of the guidance.
export function parsePolicyConfig(value: unknown): SubagentModelConfig {
  if (!isRecord(value)) return {};
  const strings = (list: unknown): string[] =>
    Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : [];
  const config: SubagentModelConfig = {};
  if (Array.isArray(value.localProviders)) config.localProviders = strings(value.localProviders);
  if (Array.isArray(value.providerGroups)) config.providerGroups = value.providerGroups.filter(Array.isArray).map(strings);
  if (Array.isArray(value.models)) {
    config.models = value.models.flatMap((entry: unknown) =>
      isRecord(entry) && typeof entry.match === "string" && typeof entry.guidance === "string"
        ? [{ match: entry.match, guidance: entry.guidance }]
        : [],
    );
  }
  return config;
}

export function guidanceTable(options: {
  mainModel: Model<Api> | undefined;
  availableModels: Model<Api>[];
  config: SubagentModelConfig;
}): string {
  const { mainModel, availableModels, config } = options;
  const allowed = guidanceLines(candidateModels(mainModel, availableModels, config), config);
  const otherProviders = guidanceLines(
    availableModels.filter((model) => isCrossProvider(model, mainModel, config)),
    config,
  );
  const sections = [allowed, otherProviders.length > 0 ? [OTHER_PROVIDERS_HEADING, ...otherProviders] : []];
  return sections
    .filter((lines) => lines.length > 0)
    .map((lines) => lines.join("\n"))
    .join("\n\n");
}

function guidanceLines(models: readonly Model<Api>[], config: SubagentModelConfig): string[] {
  return models.flatMap((model) => {
    const guidance = guidanceFor(model, config);
    return guidance ? [`- ${model.provider}/${model.id}: ${guidance}`] : [];
  });
}

export function resolveSubagentModel(options: {
  requested: string | undefined;
  mainModel: Model<Api> | undefined;
  availableModels: Model<Api>[];
  config: SubagentModelConfig;
  providerVerdicts: ReadonlyMap<string, ProviderVerdict>;
}): ModelResolution {
  const { requested, mainModel, availableModels, config, providerVerdicts } = options;
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
  if (!isCrossProvider(model, mainModel, config)) return { ok: true, model };
  const verdict = providerVerdicts.get(model.provider);
  if (verdict?.kind === "allow") return { ok: true, model };
  return { ok: false, error: crossProviderError(model, mainModel, verdict, availableModels, config) };
}

function crossProviderError(
  model: Model<Api>,
  mainModel: Model<Api> | undefined,
  verdict: Extract<ProviderVerdict, { kind: "deny" }> | undefined,
  availableModels: readonly Model<Api>[],
  config: SubagentModelConfig,
): string {
  const candidates = `Valid subagent models without it:\n${describeCandidates(mainModel, availableModels, config)}`;
  if (verdict) return `${verdict.reason} Do not retry it with crossProvider. ${candidates}`;
  const session = mainModel ? `${mainModel.provider}/${mainModel.id}` : "the session model";
  const situation =
    mainModel && isLocalModel(mainModel, config)
      ? `The session runs on a local model (${session}), so ${model.provider}/${model.id} counts as another provider.`
      : `${model.provider}/${model.id} is from another provider than the session model (${session}).`;
  return `${situation} ${CROSS_PROVIDER_RULE} ${candidates}`;
}

// What the user decided for one provider outside the session's family. reason is the full sentence for the agent.
export type ProviderVerdict = { kind: "allow" } | { kind: "deny"; reason: string };

export type ModelResolution = { ok: true; model: Model<Api> | undefined } | { ok: false; error: string };

// Unknown and ambiguous requests are skipped here; resolveSubagentModel reports them per task.
export function crossProviderTargets(options: {
  requested: readonly (string | undefined)[];
  mainModel: Model<Api> | undefined;
  availableModels: Model<Api>[];
  config: SubagentModelConfig;
}): Model<Api>[] {
  const { requested, mainModel, availableModels, config } = options;
  const targets = new Map<string, Model<Api>>();
  for (const name of requested) {
    if (name === undefined) continue;
    const matches = findRequestedModels(name, availableModels);
    const model = matches.length === 1 ? matches[0] : undefined;
    if (model && isCrossProvider(model, mainModel, config)) targets.set(`${model.provider}/${model.id}`, model);
  }
  return [...targets.values()];
}

function findRequestedModels(requested: string, availableModels: readonly Model<Api>[]): Model<Api>[] {
  const exact = availableModels.filter((model) => `${model.provider}/${model.id}` === requested);
  if (exact.length > 0) return exact;
  return availableModels.filter((model) => model.id === requested);
}

function describeCandidates(
  mainModel: Model<Api> | undefined,
  availableModels: readonly Model<Api>[],
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
  availableModels: readonly Model<Api>[],
  config: SubagentModelConfig,
): Model<Api>[] {
  if (!mainModel) return [...availableModels];
  if (isLocalModel(mainModel, config)) {
    return availableModels.filter((model) => isLocalModel(model, config));
  }
  return availableModels.filter(
    (model) => isLocalModel(model, config) || sameProviderFamily(mainModel.provider, model.provider, config),
  );
}

// A local session treats every cloud model as another provider; a cloud session treats local models as its own.
export function isCrossProvider(model: Model<Api>, mainModel: Model<Api> | undefined, config: SubagentModelConfig): boolean {
  if (!mainModel) return false;
  if (isLocalModel(model, config)) return false;
  if (isLocalModel(mainModel, config)) return true;
  return !sameProviderFamily(mainModel.provider, model.provider, config);
}

export function isLocalModel(model: Model<Api>, config: SubagentModelConfig): boolean {
  if (config.localProviders?.includes(model.provider)) return true;
  try {
    const host = new URL(model.baseUrl).hostname;
    return (
      host === "localhost" ||
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
  return (config.models ?? []).find(({ match }) => matchesWildcard(match, model.id) || matchesWildcard(match, qualified))
    ?.guidance;
}

export interface SubagentModelConfig {
  localProviders?: string[];
  providerGroups?: string[][];
  models?: { match: string; guidance: string }[];
}
