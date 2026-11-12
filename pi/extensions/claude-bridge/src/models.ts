// Canonical selection + display order for the model picker.
// Extracted from index.ts so tests can import without activating the extension.

export const FABLE_5_2_MODEL_ID = "claude-fable-5-2";
// Opus 4.8 is both a selectable model and the configured safety-fallback target for the Claude 5
// primaries whose classifiers can decline a turn (Fable 5.2, Opus 5.5).
export const FABLE_FALLBACK_MODEL_ID = "claude-opus-4-8";
// Not selectable: Claude Code reroutes bio and frontier_llm refusals of those primaries to Opus 5 on
// its own, so it only needs a label for the fallback notice.
export const OPUS_5_MODEL_ID = "claude-opus-5";
export const OPUS_5_5_MODEL_ID = "claude-opus-5-5";
export const SONNET_5_5_MODEL_ID = "claude-sonnet-5-5";
// Sonnet 5 is both a selectable model and the safety-fallback target for Sonnet 5.5.
export const SONNET_5_MODEL_ID = "claude-sonnet-5";
export const HAIKU_5_5_MODEL_ID = "claude-haiku-5-5";
// Haiku 4.5 is both a selectable model and the safety-fallback target for Haiku 5.5.
export const HAIKU_4_5_MODEL_ID = "claude-haiku-4-5";

export function fallbackModelForPrimaryModel(modelId: string): string | undefined {
	if (modelId === FABLE_5_2_MODEL_ID || modelId === OPUS_5_5_MODEL_ID) {
		return FABLE_FALLBACK_MODEL_ID;
	}
	if (modelId === SONNET_5_5_MODEL_ID) {
		return SONNET_5_MODEL_ID;
	}
	if (modelId === HAIKU_5_5_MODEL_ID) {
		return HAIKU_4_5_MODEL_ID;
	}
	return undefined;
}

export const MODEL_IDS_IN_ORDER = [
	FABLE_5_2_MODEL_ID,
	OPUS_5_5_MODEL_ID,
	FABLE_FALLBACK_MODEL_ID,
	SONNET_5_5_MODEL_ID,
	SONNET_5_MODEL_ID,
	HAIKU_5_5_MODEL_ID,
	HAIKU_4_5_MODEL_ID,
];

type BridgeModelMetadata = {
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
};

const FALLBACK_MODELS: Record<string, BridgeModelMetadata> = {
	[FABLE_5_2_MODEL_ID]: {
		id: FABLE_5_2_MODEL_ID,
		name: "Claude Fable 5.2",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		input: ["text", "image"],
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	[OPUS_5_5_MODEL_ID]: {
		id: OPUS_5_5_MODEL_ID,
		name: "Claude Opus 5.5",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		input: ["text", "image"],
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	[FABLE_FALLBACK_MODEL_ID]: {
		id: FABLE_FALLBACK_MODEL_ID,
		name: "Claude Opus 4.8",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh" },
		input: ["text", "image"],
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	[SONNET_5_5_MODEL_ID]: {
		id: SONNET_5_5_MODEL_ID,
		name: "Claude Sonnet 5.5",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		input: ["text", "image"],
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	[SONNET_5_MODEL_ID]: {
		id: SONNET_5_MODEL_ID,
		name: "Claude Sonnet 5",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		input: ["text", "image"],
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	[HAIKU_5_5_MODEL_ID]: {
		id: HAIKU_5_5_MODEL_ID,
		name: "Claude Haiku 5.5",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		input: ["text", "image"],
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	[HAIKU_4_5_MODEL_ID]: {
		id: HAIKU_4_5_MODEL_ID,
		name: "Claude Haiku 4.5",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 200000,
		maxTokens: 64000,
	},
};

const FALLBACK_ONLY_DISPLAY_NAMES: Record<string, string> = {
	[OPUS_5_MODEL_ID]: "Claude Opus 5",
};

// Human label for the safety-fallback notice. Selectable models and the fallback-only ids above
// have a label; the raw id is the last resort so an unknown reroute target still reads sensibly.
export function modelDisplayName(modelId: string): string {
	return FALLBACK_MODELS[modelId]?.name ?? FALLBACK_ONLY_DISPLAY_NAMES[modelId] ?? modelId;
}

// Claude Code picks the fallback per refusal category, so every reroute is announced, not only
// the configured pairing.
export function refusalFallbackNotice(originalModel: unknown, fallbackModel: unknown): string | undefined {
	if (typeof originalModel !== "string" || typeof fallbackModel !== "string") return undefined;
	return `Pi Claude switched ${modelDisplayName(originalModel)} to ${modelDisplayName(fallbackModel)} after Claude Code safety fallback.`;
}

// Project pi-ai's model entries down to the fields pi's registerProvider expects,
// keep MODEL_IDS_IN_ORDER ordering, and fill bridge-owned metadata for supported
// IDs absent from pi-ai. Unknown missing IDs are still dropped.
export function buildModels<T extends { id: string; [key: string]: any }>(piAiModels: T[]) {
	return MODEL_IDS_IN_ORDER
		.map((id) => piAiModels.find((m) => m.id === id) ?? FALLBACK_MODELS[id])
		.filter((m) => m != null)
		// Forward thinkingLevelMap so per-model overrides (e.g. opus-4-8 mapping
		// xhigh→xhigh instead of xhigh→max) are visible to the effort lookup.
		.map(({ id, name, reasoning, input, contextWindow, maxTokens, thinkingLevelMap }) => ({
			id, name, reasoning, input, contextWindow, maxTokens, thinkingLevelMap,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}));
}
