import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeContext } from "@earendil-works/pi-ai";
import { mapPiToolNameToSdk } from "../src/convert.ts";
import { resolveMcpTools } from "../src/index.ts";

describe("Pi tool names", () => {
	it("converts ordinary names and honors explicit custom mappings", () => {
		// arrange
		const names = ["read", "bash", "my_custom_tool", ""];
		const mappings = new Map([["my_custom_tool", "mcp__custom-tools__my_custom_tool"]]);
		// act
		const converted = names.map((name) => mapPiToolNameToSdk(name));
		const explicit = mapPiToolNameToSdk("my_custom_tool", mappings);
		// assert
		assert.deepEqual(converted, ["Read", "Bash", "MyCustomTool", ""]);
		assert.equal(explicit, "mcp__custom-tools__my_custom_tool");
	});

	it("advertises similarly named genuine Pi tools and honors exclusion", () => {
		// arrange
		const connectorNamedPiTool = "mcp__claude_ai_Slack__slack_search_channels";
		const transcript = normalizeContext({ messages: [], tools: [
			{ name: "read", description: "", parameters: { type: "object" } },
			{ name: connectorNamedPiTool, description: "", parameters: { type: "object" } },
			{ name: "bash", description: "", parameters: { type: "object" } },
		] });
		// act
		const { mcpTools, customToolNameToSdk } = resolveMcpTools(transcript, "bash");
		const mapped = mapPiToolNameToSdk(connectorNamedPiTool, customToolNameToSdk);
		// assert
		assert.deepEqual(mcpTools.map((tool) => tool.name), ["read", connectorNamedPiTool]);
		assert.equal(mapped, `mcp__custom-tools__${connectorNamedPiTool}`);
		assert.deepEqual(resolveMcpTools(normalizeContext({ messages: [] })).mcpTools, []);
	});
});
