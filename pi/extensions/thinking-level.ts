import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
	let model: Model<any> | undefined;

	pi.on("session_start", async (_event, ctx) => {
		model = ctx.model;
	});

	pi.on("model_select", async (event) => {
		model = event.model;
	});

	pi.registerCommand("thinking", {
		description: "Select the thinking/effort level of the current model",
		getArgumentCompletions: (prefix): AutocompleteItem[] | null => {
			const matches = supportedLevels(model).filter((level) => level.startsWith(prefix));
			return matches.length > 0 ? matches.map((level) => ({ value: level, label: level })) : null;
		},
		handler: async (args, ctx) => {
			model = ctx.model;
			const levels = supportedLevels(model);
			if (levels.length < 2) {
				ctx.ui.notify(`${model?.id ?? "This model"} has no selectable thinking levels`, "warning");
				return;
			}

			const requested = args.trim().toLowerCase();
			if (requested) {
				const level = levels.find((candidate) => candidate === requested);
				if (!level) {
					ctx.ui.notify(`Unknown level "${requested}". Available: ${levels.join(", ")}`, "error");
					return;
				}
				pi.setThinkingLevel(level);
				ctx.ui.notify(`Thinking level: ${level}`, "info");
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify(`Pass a level: ${levels.join(", ")}`, "error");
				return;
			}

			const current = pi.getThinkingLevel();
			const options = levels.map((level) => (level === current ? `${level} (current)` : level));
			const choice = await ctx.ui.select("Thinking level", options);
			if (choice === undefined) return;

			const level = levels[options.indexOf(choice)];
			pi.setThinkingLevel(level);
			ctx.ui.notify(`Thinking level: ${level}`, "info");
		},
	});
}

function supportedLevels(model: Model<any> | undefined): ModelThinkingLevel[] {
	return model ? getSupportedThinkingLevels(model) : [];
}
