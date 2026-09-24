/**
 * Provider re-registration policy. pi's registerNativeProvider is upsert-by-id
 * and fires a full, unawaited availability refresh that invalidates any pass
 * already in flight, so the bridge must not re-upsert on every session_start:
 * only when the credential probe's answer changed since the last upsert. The
 * process-global tokens are still (re)claimed on every trigger because
 * session_shutdown releases them.
 * Uses the real extension factory with a fake pi API — no API calls.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const ACTIVE_STREAM_SIMPLE_KEY = Symbol.for("claude-bridge:activeStreamSimple");
const PRIMARY_INSTANCE_KEY = Symbol.for("claude-bridge:primaryInstance");

// The darwin keychain fallback makes "no credentials" unobservable via env
// probes (see auth-presence.ts), so the flip assertions are pinned to other
// platforms, like unit-native-provider.mjs does.
const onDarwin = process.platform === "darwin";

const CREDENTIAL_ENV = [
	"CLAUDE_CODE_OAUTH_TOKEN",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_USE_FOUNDRY",
	"CLAUDE_CODE_USE_ANTHROPIC_AWS",
	"CLAUDE_CODE_USE_MANTLE",
	"CLAUDE_CONFIG_DIR",
	"PI_CODING_AGENT_DIR",
];

/** Run with an empty agent dir (registration writes trust state there), an
 *  empty Claude config dir and no credential env vars, restoring everything. */
async function withIsolatedEnv(run) {
	const saved = new Map(CREDENTIAL_ENV.map((key) => [key, process.env[key]]));
	const agentDir = mkdtempSync(join(tmpdir(), "bridge-upsert-agent-"));
	const configDir = mkdtempSync(join(tmpdir(), "bridge-upsert-claude-"));
	for (const key of CREDENTIAL_ENV) delete process.env[key];
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.CLAUDE_CONFIG_DIR = configDir;
	try {
		return await run();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(configDir, { recursive: true, force: true });
	}
}

function makeFakePi(handlers, registrations) {
	return {
		on: (event, handler) => { handlers.set(event, handler); },
		registerCommand: () => {},
		registerProvider: (provider) => { registrations.push(provider); },
		events: { emit: () => {} },
		appendEntry: () => {},
	};
}

function makeCtx(sessionId) {
	const sessionManager = {
		getSessionId: () => sessionId,
		getEntries: () => [],
		getCwd: () => process.cwd(),
		buildSessionContext: () => ({ messages: [] }),
	};
	return { sessionManager, ui: { notify: () => {} }, cwd: process.cwd() };
}

/** Each test gets its own module instance so the process-global primary token
 *  starts unclaimed; the previous instance releases it on session_shutdown. */
async function freshBridge() {
	const mod = await import(`../src/index.ts?instance=${Date.now()}-${Math.random()}`);
	return mod.default;
}

describe("provider registration upsert policy", () => {
	it("registers once at load and skips session_start re-upserts while the credential probe is unchanged", async () => {
		await withIsolatedEnv(async () => {
			const claudeBridge = await freshBridge();
			const handlers = new Map();
			const registrations = [];
			claudeBridge(makeFakePi(handlers, registrations));
			assert.equal(registrations.length, 1, "load registers the provider");

			const ctx = makeCtx("s1");
			handlers.get("session_start")({ reason: "startup" }, ctx);
			handlers.get("session_start")({ reason: "new" }, ctx);
			handlers.get("session_start")({ reason: "resume" }, ctx);
			assert.equal(registrations.length, 1, "no re-upsert without a credential change");

			handlers.get("session_shutdown")({ reason: "quit" }, ctx);
		});
	});

	it("reclaims the stream guard and primary token on a skipped re-upsert after session_shutdown released them", async () => {
		await withIsolatedEnv(async () => {
			const claudeBridge = await freshBridge();
			const handlers = new Map();
			const registrations = [];
			claudeBridge(makeFakePi(handlers, registrations));
			const first = makeCtx("s1");
			handlers.get("session_start")({ reason: "startup" }, first);

			handlers.get("session_shutdown")({ reason: "new" }, first);
			assert.equal(globalThis[ACTIVE_STREAM_SIMPLE_KEY], undefined, "shutdown releases the stream guard");
			assert.equal(globalThis[PRIMARY_INSTANCE_KEY], undefined, "shutdown releases the primary token");

			const second = makeCtx("s2");
			handlers.get("session_start")({ reason: "new" }, second);
			assert.equal(registrations.length, 1, "the same provider object stays registered; no re-upsert");
			assert.equal(typeof globalThis[ACTIVE_STREAM_SIMPLE_KEY], "function", "the stream guard is owned again");
			assert.equal(typeof globalThis[PRIMARY_INSTANCE_KEY], "function", "the primary token is owned again");

			handlers.get("session_shutdown")({ reason: "quit" }, second);
		});
	});

	it("re-upserts the same provider object when the credential probe flips, then settles again", { skip: onDarwin && "darwin keychain fallback makes the probe always true" }, async () => {
		await withIsolatedEnv(async () => {
			const claudeBridge = await freshBridge();
			const handlers = new Map();
			const registrations = [];
			claudeBridge(makeFakePi(handlers, registrations));
			assert.equal(registrations.length, 1, "load registers while logged out");
			const ctx = makeCtx("s1");

			process.env.CLAUDE_CODE_OAUTH_TOKEN = "present";
			handlers.get("session_start")({ reason: "startup" }, ctx);
			assert.equal(registrations.length, 2, "login since the last upsert re-upserts");
			assert.equal(registrations[1], registrations[0], "the SAME provider object is upserted (replace-by-id)");

			handlers.get("session_start")({ reason: "new" }, ctx);
			assert.equal(registrations.length, 2, "unchanged again: no re-upsert");

			delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
			handlers.get("session_start")({ reason: "new" }, ctx);
			assert.equal(registrations.length, 3, "logout re-upserts so pi hides the models");

			handlers.get("session_shutdown")({ reason: "quit" }, ctx);
		});
	});
});
