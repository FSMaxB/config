import type { Api, Model } from "@earendil-works/pi-ai";
import { isOffByDefaultModel } from "../lib/model-defaults.ts";
import type { SubagentModelConfig } from "../subagent/model-policy.ts";

export const STATE_ENTRY_TYPE = "rtk-state";

export const RtkMode = {
  On: "on",
  Off: "off",
} as const;
export type RtkMode = (typeof RtkMode)[keyof typeof RtkMode];

export type RtkState = { mode: RtkMode };

type SessionEntry = Readonly<{ type: string; customType?: string; data?: unknown }>;

type RtkSettings = { rtk?: { alwaysOn?: unknown } };

export function resolveMode(options: {
  saved: RtkMode | undefined;
  flag: RtkMode | undefined;
  settings: object;
  model: Model<Api> | undefined;
  policyConfig: SubagentModelConfig;
}): RtkMode {
  return (
    options.saved ??
    options.flag ??
    modelDefaultMode(options.settings, options.model, options.policyConfig)
  );
}

/** The last `rtk-state` entry on the branch wins, so `/tree` restores the state of that point. */
export function savedMode(entries: readonly SessionEntry[]): RtkMode | undefined {
  let saved: RtkMode | undefined;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
    const mode = (entry.data as Partial<RtkState> | undefined)?.mode;
    if (mode === RtkMode.On || mode === RtkMode.Off) saved = mode;
  }
  return saved;
}

/** `--no-rtk` wins over `--rtk` when both are given. */
export function flagMode(rtkFlag: unknown, noRtkFlag: unknown): RtkMode | undefined {
  if (noRtkFlag === true) return RtkMode.Off;
  if (rtkFlag === true) return RtkMode.On;
  return undefined;
}

/** The mode `/rtk <argument>` asks for, or undefined for an argument it does not know. */
export function commandMode(argument: string, current: RtkMode): RtkMode | undefined {
  switch (argument.trim().toLowerCase()) {
    case "":
      return current === RtkMode.On ? RtkMode.Off : RtkMode.On;
    case "on":
      return RtkMode.On;
    case "off":
      return RtkMode.Off;
    default:
      return undefined;
  }
}

function modelDefaultMode(
  settings: object,
  model: Model<Api> | undefined,
  policyConfig: SubagentModelConfig,
): RtkMode {
  const { rtk } = settings as RtkSettings;
  if (rtk?.alwaysOn !== true) return RtkMode.Off;
  return isOffByDefaultModel(model, policyConfig) ? RtkMode.Off : RtkMode.On;
}
