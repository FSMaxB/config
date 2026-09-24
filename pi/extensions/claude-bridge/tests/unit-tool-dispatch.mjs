import { it } from "node:test";
import assert from "node:assert/strict";
import { isPiDispatchable } from "../src/tool-mapping.ts";

const manifest = new Map([["mcp__custom-tools__read", "read"], ["mcp__custom-tools__grep", "grep"]]);
const dispatch = [
	["bash", manifest, false], ["grep", manifest, false],
	["mcp__filesystem__read_file", manifest, false], ["mcp/filesystem/read_file", manifest, false],
	["mcp/filesystem/read_file", new Map(), false],
	["mcp__custom-tools__grep", manifest, true], ["mcp__custom_tools__grep", manifest, true], ["mcp/custom-tools/grep", manifest, true],
	["mcp__custom-tools__missing", manifest, false],
	["ListMcpResources", manifest, false], ["ListMcpResourcesTool", manifest, false],
	["ReadMcpResource", manifest, false], ["ReadMcpResourceTool", manifest, false],
	["mcp__custom-tools__ReadMcpResourceTool", new Map([["mcp__custom-tools__ReadMcpResourceTool", "ReadMcpResourceTool"]]), true],
	["grep", new Map(), false],
];
for (const [name, available, expected] of dispatch) it(`dispatches ${name} with ${available.size} manifest entries`, () => { assert.equal(isPiDispatchable(name, available), expected); });
