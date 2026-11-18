import type { Tool } from "@earendil-works/pi-ai";
import { isRecord } from "../../lib/untyped.ts";

// Sonnet and Haiku often write pi's nested `edits` array as broken JSON with XML-style keys
// (`[{"oldText">…`), which fails validation. Flat string parameters are emitted raw, which is also why
// Claude Code's own Edit tool has no array. pi's edit tool folds top-level oldText/newText into `edits`
// itself (prepareArguments), so only the advertised schema changes; the arguments pass through untouched.
const FLAT_EDIT_PARAMETERS = {
	type: "object",
	required: ["path", "oldText", "newText"],
	properties: {
		path: { type: "string", description: "Path to the file to edit (relative or absolute)" },
		oldText: { type: "string", description: "Exact text to replace. It must match one unique region of the file." },
		newText: { type: "string", description: "Replacement text." },
	},
};

const FLAT_EDIT_DESCRIPTION =
	"Edit a single file by replacing one exact, unique piece of text. For several changes, make one call per change; calls may run in parallel, and each one matches against the file as it is when it runs. Keep oldText short but unique, and merge nearby changes into one call instead of overlapping ones.";

export function modelFacingTool(tool: Tool): ModelFacingTool {
	if (tool.name !== "edit" || !hasPiEditShape(tool.parameters)) return { description: tool.description, parameters: tool.parameters };
	return { description: withFirstParagraph(tool.description, FLAT_EDIT_DESCRIPTION), parameters: FLAT_EDIT_PARAMETERS };
}

export interface ModelFacingTool {
	description: string;
	parameters: unknown;
}

// Only pi's own edit shape is flattened: another extension's edit tool may take arguments that pi's
// prepareArguments does not fold.
function hasPiEditShape(parameters: unknown): boolean {
	if (!isRecord(parameters) || !isRecord(parameters.properties)) return false;
	return Object.keys(parameters.properties).sort().join(",") === "edits,path";
}

// pi/extensions/files.ts appends its path-permission note as a later paragraph; keep it.
function withFirstParagraph(description: string, replacement: string): string {
	const rest = description.indexOf("\n\n");
	return rest === -1 ? replacement : replacement + description.slice(rest);
}
