/**
 * An interrupted Claude Code child records a rejected tool_result for every
 * pending tool call before it exits. The abort path only keeps the session when
 * the transcript on disk shows that.
 */
import "./lib/debug-env.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createSession } from "cc-session-io";
import { claudeSessionPairsToolCalls } from "../src/session-persistence.ts";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const toolUse = { type: "tool_use", id: "call-1", name: "mytool", input: {} };

let claudeDir;
let cwd;

beforeEach(() => {
	claudeDir = mkdtempSync(join(tmpdir(), "bridge-pairing-claude-"));
	cwd = mkdtempSync(join(tmpdir(), "bridge-pairing-cwd-"));
});
afterEach(() => {
	rmSync(claudeDir, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

describe("claudeSessionPairsToolCalls", () => {
	it("is false for a session that does not exist", () => {
		// act
		const pairs = claudeSessionPairsToolCalls(SESSION_ID, cwd, claudeDir);

		// assert
		assert.equal(pairs, false);
	});

	it("is true when every tool_use has a tool_result", () => {
		// arrange
		const session = createSession({ sessionId: SESSION_ID, projectPath: cwd, claudeDir });
		session.addUserMessage("hello");
		session.addAssistantMessage([toolUse], { stopReason: "tool_use" });
		session.addToolResults([{ toolUseId: "call-1", content: "rejected", isError: true }]);
		session.save();

		// act
		const pairs = claudeSessionPairsToolCalls(SESSION_ID, cwd, claudeDir);

		// assert
		assert.equal(pairs, true);
	});

	it("is false when a tool_use has no tool_result", () => {
		// arrange
		const session = createSession({ sessionId: SESSION_ID, projectPath: cwd, claudeDir });
		session.addUserMessage("hello");
		session.addAssistantMessage([toolUse], { stopReason: "tool_use" });
		session.save();

		// act
		const pairs = claudeSessionPairsToolCalls(SESSION_ID, cwd, claudeDir);

		// assert
		assert.equal(pairs, false);
	});
});
