import { waitFor } from "./lib/wait-for.mjs";
/**
 * Session persistence over a pi 0.86+ built session context: Pi's system
 * messages (prompt sections, tool deltas, compaction state) sit in
 * buildSessionContext().messages, but the persisted cursor and fingerprint
 * index conversation messages only (see src/transcript.ts).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createSession } from "cc-session-io";

import {
	__testGetBridgeIntegrityState,
	__testSetBridgeIntegrityState,
	setExtensionApi,
} from "../src/bridge-state.ts";
import {
	__testCancelAllScheduledSessionPersistence,
	restoreSharedSessionFromPi,
	schedulePersistSharedSession,
} from "../src/session-persistence.ts";

let root;
let cwd;
let claudeDir;
let savedClaudeConfigDir;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "claude-transcript-persistence-"));
	cwd = join(root, "project");
	claudeDir = join(root, "claude");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(claudeDir, { recursive: true });
	savedClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
	process.env.CLAUDE_CONFIG_DIR = claudeDir;
	__testCancelAllScheduledSessionPersistence();
	setExtensionApi(undefined);
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
});

afterEach(() => {
	__testCancelAllScheduledSessionPersistence();
	setExtensionApi(undefined);
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
	if (savedClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
	else process.env.CLAUDE_CONFIG_DIR = savedClaudeConfigDir;
	rmSync(root, { recursive: true, force: true });
});

describe("persistence over a transcript with system messages", () => {
	it("fingerprints and restores over conversation messages only", async () => {
		// arrange: the same conversation, once bare and once with Pi's system messages around it
		const user = { role: "user", content: "hello", timestamp: 1 };
		const system = { role: "system", content: "", sections: { cwd: "<cwd>\n/repo\n</cwd>" }, timestamp: 0 };
		const child = createSession({ projectPath: cwd, claudeDir });
		child.addUserMessage("hello");
		child.save();
		const persisted = [];
		setExtensionApi({ appendEntry(type, data) { persisted.push({ type, data }); } });
		const persist = (messages) => {
			__testSetBridgeIntegrityState({ sharedSession: { sessionId: child.sessionId, cursor: 1, cwd } });
			schedulePersistSharedSession({ sessionManager: { buildSessionContext: () => ({ messages }), getSessionId: () => "pi-session" } });
		};

		// act
		persist([user]);
		await waitFor(() => persisted.length === 1);
		persist([system, user, system]);
		await waitFor(() => persisted.length === 2);
		__testSetBridgeIntegrityState({ sharedSession: null });
		restoreSharedSessionFromPi({
			cwd,
			sessionManager: {
				getEntries: () => [{ type: "custom", customType: "claude-bridge-session", data: persisted[1].data }],
				getSessionId: () => "pi-session",
				getCwd: () => cwd,
				buildSessionContext: () => ({ messages: [system, user, system] }),
			},
		});

		// assert
		assert.equal(persisted[1].data.fingerprint, persisted[0].data.fingerprint, "system messages do not enter the fingerprint");
		assert.equal(persisted[1].data.cursor, 1);
		assert.deepEqual(__testGetBridgeIntegrityState().sharedSession, { sessionId: child.sessionId, cursor: 1, cwd });
	});
});
