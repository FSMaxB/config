import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildClaudeQueryOptions, systemPromptModeForQuery } from "../src/query-options.ts";

const skillsBlock = "The following skills provide specialized instructions for specific tasks.\n<available_skills>\n</available_skills>";
const readTool = { name: "read", description: "", parameters: { type: "object" } };
const extractionPrompt = "Return ONLY JSON {\"summary\":string,\"claims\":[]}";

function build(overrides) {
	return buildClaudeQueryOptions({
		cwd: process.cwd(), requestedModel: { id: "claude-haiku-4-5" }, bridgeConfig: {},
		resumeSessionId: null, mcpServers: undefined, ...overrides,
	});
}

describe("system prompt mode", () => {
	it("passes the caller's system prompt verbatim when the request offers no tools", () => {
		// arrange
		const input = { tools: [], systemPrompt: extractionPrompt };
		// act
		const mode = systemPromptModeForQuery(input.tools, input.systemPrompt);
		const built = build(input);
		// assert
		assert.equal(mode, "verbatim");
		assert.equal(built.systemPromptMode, "verbatim");
		assert.equal(built.appendSystemPrompt, false);
		assert.equal(built.queryOptions.systemPrompt, extractionPrompt);
	});

	it("keeps the Claude Code preset with the skills append when tools are offered", () => {
		// arrange
		const input = { tools: [readTool], systemPrompt: `Pi prompt\n\n${skillsBlock}` };
		// act
		const built = build(input);
		// assert
		assert.equal(built.systemPromptMode, "claude-code-preset");
		assert.equal(built.appendSystemPrompt, true);
		assert.equal(built.queryOptions.systemPrompt.type, "preset");
		assert.equal(built.queryOptions.systemPrompt.preset, "claude_code");
		assert.match(built.queryOptions.systemPrompt.append, /<available_skills>/);
	});

	it("falls back to the Claude Code preset when a tool-less request has no system prompt", () => {
		// arrange
		const input = { tools: [], systemPrompt: "" };
		// act
		const built = build(input);
		// assert
		assert.equal(built.systemPromptMode, "claude-code-preset");
		assert.equal(built.queryOptions.systemPrompt.type, "preset");
	});
});
