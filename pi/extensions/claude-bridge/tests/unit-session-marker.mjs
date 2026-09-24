import { waitFor } from "./lib/wait-for.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { createSession } from "cc-session-io";
import { __testGetBridgeIntegrityState, __testSetBridgeIntegrityState, setExtensionApi } from "../src/bridge-state.ts";
import { __testCancelAllScheduledSessionPersistence, restoreSharedSessionFromPi, schedulePersistSharedSession } from "../src/session-persistence.ts";

const root = mkdtempSync(join(tmpdir(), "claude-session-marker-"));
const cwd = join(root, "project");
const claudeDir = join(root, "claude");
const messages = [{ role: "user", content: "hello", timestamp: 1 }];

beforeEach(() => {
	mkdirSync(cwd, { recursive: true });
	mkdirSync(claudeDir, { recursive: true });
	__testCancelAllScheduledSessionPersistence();
	setExtensionApi(undefined);
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
});
afterEach(() => {
	__testCancelAllScheduledSessionPersistence();
	setExtensionApi(undefined);
	__testSetBridgeIntegrityState({ sharedSession: null, ui: null });
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("bridge session markers", () => {
	it("persists an ordinary marker without a credential directory or profile", async () => {
		// arrange
		const entries = [];
		setExtensionApi({ appendEntry(type, data) { entries.push({ type, data }); } });
		__testSetBridgeIntegrityState({ sharedSession: { sessionId: "child-session", cursor: 1, cwd } });
		// act
		schedulePersistSharedSession({ sessionManager: {
			buildSessionContext: () => ({ messages }), getSessionId: () => "pi-session",
		} });
		assert.equal(await waitFor(() => entries.length === 1), true);
		// assert
		assert.equal(entries[0].type, "claude-bridge-session");
		assert.equal(entries[0].data.fingerprint, createHash("sha256").update(JSON.stringify(messages)).digest("hex"));
		assert.equal(entries[0].data.piSessionId, "pi-session");
		assert.equal("claudeConfigDir" in entries[0].data, false);
		assert.equal("accountProfileId" in entries[0].data, false);
	});

	it("rejects legacy profile markers instead of resuming them under the ambient login", () => {
		// arrange
		const child = createSession({ projectPath: cwd, claudeDir });
		child.addUserMessage("hello");
		child.save();
		const marker = makeMarker(child.sessionId, { accountProfileId: "profile-a" });
		const previousDir = process.env.CLAUDE_CONFIG_DIR;
		process.env.CLAUDE_CONFIG_DIR = claudeDir;
		try {
			// act
			restoreSharedSessionFromPi({ cwd, sessionManager: sessionManager(marker) });
			// assert
			assert.equal(__testGetBridgeIntegrityState().sharedSession, null);
		} finally {
			if (previousDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
			else process.env.CLAUDE_CONFIG_DIR = previousDir;
		}
	});

	it("restores an ordinary marker when the fingerprint and child session match", () => {
		// arrange
		const child = createSession({ projectPath: cwd, claudeDir });
		child.addUserMessage("hello");
		child.save();
		const previousDir = process.env.CLAUDE_CONFIG_DIR;
		process.env.CLAUDE_CONFIG_DIR = claudeDir;
		try {
			// act
			restoreSharedSessionFromPi({ cwd, sessionManager: sessionManager(makeMarker(child.sessionId)) });
			// assert
			assert.deepEqual(__testGetBridgeIntegrityState().sharedSession, { sessionId: child.sessionId, cursor: 1, cwd });
		} finally {
			if (previousDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
			else process.env.CLAUDE_CONFIG_DIR = previousDir;
		}
	});
});

function makeMarker(sessionId, extra = {}) {
	return { type: "custom", customType: "claude-bridge-session", data: {
		sessionId, cursor: 1, cwd, ...extra,
		fingerprint: createHash("sha256").update(JSON.stringify(messages)).digest("hex"),
		piSessionId: "pi-session", updatedAt: new Date().toISOString(),
	} };
}

function sessionManager(marker) {
	return {
		getEntries: () => [marker], getSessionId: () => "pi-session",
		getCwd: () => cwd, buildSessionContext: () => ({ messages }),
	};
}
