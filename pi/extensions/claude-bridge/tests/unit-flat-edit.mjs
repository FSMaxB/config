import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import { modelFacingTool } from "../src/flat-edit.ts";

const FLAT_PARAMETERS = {
	type: "object",
	required: ["path", "oldText", "newText"],
	properties: {
		path: { type: "string", description: "Path to the file to edit (relative or absolute)" },
		oldText: { type: "string", description: "Exact text to replace. It must match one unique region of the file." },
		newText: { type: "string", description: "Replacement text." },
	},
};

function piEditTool() {
	const definition = createEditToolDefinition(process.cwd());
	return { name: "edit", description: `${definition.description}\n\nACCESS NOTE`, parameters: definition.parameters };
}

describe("modelFacingTool", () => {
	it("flattens pi's edit tool and keeps the paragraphs after the first", () => {
		// arrange
		const tool = piEditTool();

		// act
		const advertised = modelFacingTool(tool);

		// assert
		assert.deepEqual(advertised.parameters, FLAT_PARAMETERS);
		assert.ok(advertised.description.startsWith("Edit a single file by replacing one exact, unique piece of text."));
		assert.ok(advertised.description.endsWith("\n\nACCESS NOTE"));
	});

	it("leaves other tools alone", () => {
		// arrange
		const tool = { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } };

		// act
		const advertised = modelFacingTool(tool);

		// assert
		assert.equal(advertised.description, tool.description);
		assert.equal(advertised.parameters, tool.parameters);
	});

	it("leaves an edit tool of another shape alone", () => {
		// arrange
		const tool = { name: "edit", description: "Apply a patch", parameters: { type: "object", properties: { path: { type: "string" }, patch: { type: "string" } } } };

		// act
		const advertised = modelFacingTool(tool);

		// assert
		assert.equal(advertised.description, tool.description);
		assert.equal(advertised.parameters, tool.parameters);
	});

	it("produces arguments that pi's edit tool folds into edits", () => {
		// arrange
		const definition = createEditToolDefinition(process.cwd());
		const flat = { path: "a.txt", oldText: "x", newText: "y" };

		// act
		const prepared = definition.prepareArguments(flat);

		// assert
		assert.deepEqual(prepared, { path: "a.txt", edits: [{ oldText: "x", newText: "y" }] });
	});
});
