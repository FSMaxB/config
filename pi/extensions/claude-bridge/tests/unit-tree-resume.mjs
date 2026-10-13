import "./lib/debug-env.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { createSession } from "cc-session-io";
import { __testGetBridgeIntegrityState, __testSetBridgeIntegrityState, adoptTreeResumeTarget } from "../src/index.ts";
import { resetStack } from "../src/query-state.ts";
import { conversationFingerprint } from "../src/session-persistence.ts";
import { findTreeResumeTarget, resolveForkPoint } from "../src/tree-resume.ts";

const root = mkdtempSync(join(tmpdir(), "claude-tree-resume-"));
const cwd = join(root, "project");
const claudeDir = join(root, "claude");

const user = (text) => ({ role: "user", content: text, timestamp: 1 });
const stampedAssistant = (text, messageId, overrides = {}) => ({
	role: "assistant", content: [{ type: "text", text }], provider: "pi-claude", stopReason: "stop", timestamp: 2,
	claudeBridge: { sessionId: "s1", messageId }, ...overrides,
});
const messageEntry = (message, id) => ({ sourceEntry: { type: "message", id, parentId: null, timestamp: "", message }, messages: [message] });
const stateEntry = (type, messages = []) => ({ sourceEntry: { type, id: `${type}-1`, parentId: null, timestamp: "" }, messages });
const projectionOf = (entries, leadingMessages = []) => ({ entries, messages: [...leadingMessages, ...entries.flatMap((entry) => entry.messages)] });

beforeEach(() => {
	mkdirSync(cwd, { recursive: true });
	mkdirSync(claudeDir, { recursive: true });
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
});
afterEach(() => {
	resetStack();
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("findTreeResumeTarget", () => {
	const first = user("hi");
	const reply = stampedAssistant("a1", "msg_1");

	it("accepts a branch that ends with a stamped bridge reply", () => {
		// arrange
		const projection = projectionOf([messageEntry(first, "e1"), messageEntry(reply, "e2")]);
		// act
		const target = findTreeResumeTarget(projection);
		// assert
		assert.deepEqual({ ...target, conversation: target.conversation.length }, { sessionId: "s1", messageId: "msg_1", conversation: 2 });
	});

	it("ignores state-only entries after the reply, such as the bridge marker", () => {
		// arrange
		const projection = projectionOf([messageEntry(first, "e1"), messageEntry(reply, "e2"), stateEntry("custom")]);
		// act
		const target = findTreeResumeTarget(projection);
		// assert
		assert.equal(target.messageId, "msg_1");
	});

	it("does not count leading system messages in the conversation", () => {
		// arrange
		const projection = projectionOf([messageEntry(first, "e1"), messageEntry(reply, "e2")], [{ role: "system", content: "prompt", timestamp: 0 }]);
		// act
		const target = findTreeResumeTarget(projection);
		// assert
		assert.equal(target.conversation.length, 2);
	});

	it("rejects a branch that ends with a branch summary", () => {
		// arrange
		const summary = { role: "branchSummary", summary: "s", timestamp: 3 };
		const projection = projectionOf([messageEntry(first, "e1"), messageEntry(reply, "e2"), stateEntry("branch_summary", [summary])]);
		// act
		const target = findTreeResumeTarget(projection);
		// assert
		assert.match(target, /branch_summary/);
	});

	it("rejects every other branch shape", () => {
		// arrange
		const rows = [
			["an empty branch", projectionOf([stateEntry("custom")]), /no messages/],
			["a trailing user message", projectionOf([messageEntry(first, "e1")]), /ends with a user message/],
			["a tool call", projectionOf([messageEntry(first, "e1"), messageEntry(stampedAssistant("a1", "msg_1", { content: [{ type: "toolCall", id: "c1", name: "echo", arguments: {} }] }), "e2")]), /calls tools/],
			["an aborted reply", projectionOf([messageEntry(first, "e1"), messageEntry(stampedAssistant("a1", "msg_1", { stopReason: "aborted" }), "e2")]), /stopped with aborted/],
			["a reply without a stamp", projectionOf([messageEntry(first, "e1"), messageEntry(stampedAssistant("a1", "msg_1", { claudeBridge: undefined }), "e2")]), /no Claude transcript anchor/],
			["a foreign provider", projectionOf([messageEntry(first, "e1"), messageEntry(stampedAssistant("a1", "msg_1", { provider: "anthropic" }), "e2")]), /came from anthropic/],
		];
		for (const [name, projection, expected] of rows) {
			// act
			const target = findTreeResumeTarget(projection);
			// assert
			assert.equal(typeof target, "string", name);
			assert.match(target, expected, name);
		}
	});
});

describe("resolveForkPoint", () => {
	it("finds the last record of the stamped message and whether it is the tail", () => {
		// arrange
		const { sessionId, uuids } = writeTranscript();
		// act
		const middle = resolveForkPoint({ sessionId, messageId: "msg_1" }, cwd, claudeDir);
		const tail = resolveForkPoint({ sessionId, messageId: "msg_2" }, cwd, claudeDir);
		// assert
		assert.deepEqual(middle, { uuid: uuids[0], isTail: false });
		assert.deepEqual(tail, { uuid: uuids[1], isTail: true });
	});

	it("rejects a message the transcript does not hold and a session that does not exist", () => {
		// arrange
		const { sessionId } = writeTranscript();
		// act
		const missingMessage = resolveForkPoint({ sessionId, messageId: "msg_missing" }, cwd, claudeDir);
		const missingSession = resolveForkPoint({ sessionId: "00000000-0000-4000-8000-000000000000", messageId: "msg_1" }, cwd, claudeDir);
		// assert
		assert.equal(typeof missingMessage, "string");
		assert.equal(typeof missingSession, "string");
	});
});

describe("adoptTreeResumeTarget", () => {
	it("forks at a record before the transcript's tail", () => {
		// arrange
		const { sessionId, uuids } = writeTranscript();
		const branch = [user("hi"), stampedAssistant("a1", "msg_1", { claudeBridge: { sessionId, messageId: "msg_1" } })];
		const stale = { sessionId, cursor: 4, cwd, needsRebuild: true, rebuildReason: "pi replaced the history (session_tree)" };
		__testSetBridgeIntegrityState({ sharedSession: stale });
		// act
		withClaudeDir(() => adoptTreeResumeTarget(sessionManagerFor(branch)));
		// assert
		assert.deepEqual(__testGetBridgeIntegrityState().sharedSession, {
			sessionId, cursor: 2, cwd, conversationFingerprint: conversationFingerprint(branch), forkAt: uuids[0],
		});
	});

	it("resumes without a fork when the branch ends at the transcript's tail", () => {
		// arrange
		const { sessionId } = writeTranscript();
		const branch = [user("hi"), stampedAssistant("a1", "msg_1", { claudeBridge: { sessionId, messageId: "msg_1" } }), user("more"), stampedAssistant("a2", "msg_2", { claudeBridge: { sessionId, messageId: "msg_2" } })];
		__testSetBridgeIntegrityState({ sharedSession: { sessionId, cursor: 4, cwd, needsRebuild: true } });
		// act
		withClaudeDir(() => adoptTreeResumeTarget(sessionManagerFor(branch)));
		// assert
		assert.deepEqual(__testGetBridgeIntegrityState().sharedSession, {
			sessionId, cursor: 4, cwd, conversationFingerprint: conversationFingerprint(branch),
		});
	});

	it("leaves the rebuild mark alone when the branch cannot be resumed", () => {
		// arrange
		const { sessionId } = writeTranscript();
		const stale = { sessionId, cursor: 4, cwd, needsRebuild: true };
		__testSetBridgeIntegrityState({ sharedSession: stale });
		const rejected = [user("hi"), stampedAssistant("a1", "msg_1", { stopReason: "aborted", claudeBridge: { sessionId, messageId: "msg_1" } })];
		const unresolvable = [user("hi"), stampedAssistant("a1", "msg_gone", { claudeBridge: { sessionId, messageId: "msg_gone" } })];
		for (const branch of [rejected, unresolvable]) {
			// act
			withClaudeDir(() => adoptTreeResumeTarget(sessionManagerFor(branch)));
			// assert
			assert.deepEqual(__testGetBridgeIntegrityState().sharedSession, stale);
		}
	});
});

function sessionManagerFor(branch) {
	const projection = projectionOf(branch.map((message, index) => messageEntry(message, `e${index}`)));
	return { buildSessionProjection: () => projection, getCwd: () => cwd };
}

function withClaudeDir(fn) {
	const previous = process.env.CLAUDE_CONFIG_DIR;
	process.env.CLAUDE_CONFIG_DIR = claudeDir;
	try {
		fn();
	} finally {
		if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = previous;
	}
}

/** A two-turn Claude transcript whose assistant records carry API message ids msg_1 and msg_2, the way Claude Code writes them. */
function writeTranscript() {
	const session = createSession({ projectPath: cwd, claudeDir });
	session.addUserMessage("hi");
	const first = session.addAssistantMessage([{ type: "text", text: "a1" }]);
	session.addUserMessage("more");
	const second = session.addAssistantMessage([{ type: "text", text: "a2" }]);
	session.save();
	const ids = new Map([[first, "msg_1"], [second, "msg_2"]]);
	const rewritten = readFileSync(session.jsonlPath, "utf8").split("\n").filter(Boolean).map((line) => {
		const record = JSON.parse(line);
		if (record.type === "assistant" && ids.has(record.uuid)) record.message.id = ids.get(record.uuid);
		return JSON.stringify(record);
	});
	writeFileSync(session.jsonlPath, `${rewritten.join("\n")}\n`);
	return { sessionId: session.sessionId, uuids: [first, second] };
}
