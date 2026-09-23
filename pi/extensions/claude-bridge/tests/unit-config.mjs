/**
 * Tests for claude-bridge extension-manager config projection.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, recordProjectTrust } from "../src/config.ts";

function withTempDirs(fn) {
	const root = mkdtempSync(join(tmpdir(), "claude-bridge-config-"));
	const oldPiDir = process.env.PI_CODING_AGENT_DIR;
	try {
		const user = join(root, "user");
		const project = join(root, "project");
		mkdirSync(join(user), { recursive: true });
		mkdirSync(join(project, ".pi"), { recursive: true });
		process.env.PI_CODING_AGENT_DIR = user;
		return fn({ user, project });
	} finally {
		if (oldPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldPiDir;
		rmSync(root, { recursive: true, force: true });
	}
}

describe("loadConfig", () => {
	it("ignores untrusted project config", () => withTempDirs(({ user, project }) => {
		// arrange
		writeFileSync(join(user, "claude-bridge.json"), JSON.stringify({ provider: { fastMode: false } }));
		writeFileSync(join(project, ".pi", "claude-bridge.json"), JSON.stringify({ provider: { fastMode: true } }));
		// act
		const config = loadConfig(project);
		// assert
		assert.equal(config.provider?.fastMode, false);
	}));

	it("reads trusted project config from project root when cwd is nested", () => withTempDirs(({ project }) => {
		const nested = join(project, "src", "feature");
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(project, ".pi", "settings.json"), "{}");
		writeFileSync(join(project, ".pi", "claude-bridge.json"), JSON.stringify({ provider: { fastMode: true } }));
		recordProjectTrust({ cwd: nested, isProjectTrusted: () => true });

		const config = loadConfig(nested);
		assert.equal(config.provider?.fastMode, true);
	}));

	it("lets trusted project config override user config", () => withTempDirs(({ user, project }) => {
		// arrange
		writeFileSync(join(user, "claude-bridge.json"), JSON.stringify({ provider: { fastMode: false } }));
		writeFileSync(join(project, ".pi", "claude-bridge.json"), JSON.stringify({ provider: { fastMode: true } }));
		recordProjectTrust({ cwd: project, isProjectTrusted: () => true });
		// act
		const config = loadConfig(project);
		// assert
		assert.equal(config.provider?.fastMode, true);
	}));

	it("layers nested effort overrides", () => withTempDirs(({ user, project }) => {
		// arrange
		writeFileSync(join(user, "claude-bridge.json"), JSON.stringify({ provider: { forceEffort: "high" } }));
		writeFileSync(join(project, ".pi", "claude-bridge.json"), JSON.stringify({ provider: {
			forceEffort: "max", modelEffortOverrides: { "claude-opus-4-8": "xhigh", ignored: "bogus" },
		} }));
		recordProjectTrust({ cwd: project, isProjectTrusted: () => true });
		// act
		const config = loadConfig(project);
		// assert
		assert.equal(config.provider?.forceEffort, "max");
		assert.deepEqual(config.provider?.modelEffortOverrides, { "claude-opus-4-8": "xhigh" });
	}));

	it("invalid higher effort overrides clear lower values", () => withTempDirs(({ user, project }) => {
		// arrange
		writeFileSync(join(user, "claude-bridge.json"), JSON.stringify({ provider: { forceEffort: "max", modelEffortOverrides: { opus: "max" } } }));
		writeFileSync(join(project, ".pi", "claude-bridge.json"), JSON.stringify({ provider: { forceEffort: "none", modelEffortOverrides: "{}" } }));
		recordProjectTrust({ cwd: project, isProjectTrusted: () => true });
		// act
		const config = loadConfig(project);
		// assert
		assert.equal(config.provider?.forceEffort, undefined);
		assert.equal(config.provider?.modelEffortOverrides, undefined);
	}));

	it("does not allow trusted projects to enable cloud connectors while they remain supported", () => withTempDirs(({ project }) => {
		// arrange
		writeFileSync(join(project, ".pi", "claude-bridge.json"), JSON.stringify({ provider: {
			fastMode: true, enableConnectors: true, connectorWriteMode: "allow",
		} }));
		recordProjectTrust({ cwd: project, isProjectTrusted: () => true });
		// act
		const config = loadConfig(project);
		// assert
		assert.equal(config.provider?.fastMode, true);
		assert.equal(config.provider?.enableConnectors, undefined);
		assert.equal(config.provider?.connectorWriteMode, undefined);
	}));

	it("ignores flat keys, manager settings, and removed prompt hooks", () => withTempDirs(({ user, project }) => {
		// arrange
		writeFileSync(join(user, "settings.json"), JSON.stringify({ kendex: { extensionManager: { config: {
			"@vanillagreen/pi-claude-bridge": { enabled: false, fastMode: true },
		} } } }));
		writeFileSync(join(user, "claude-bridge.json"), JSON.stringify({
			fastMode: true, includeAppendSystemPromptMd: true,
			provider: { unknownSetting: "ignored" },
			promptContext: { includeCavemanHook: true },
		}));
		// act
		const config = loadConfig(project);
		// assert
		assert.equal(config.enabled, true);
		assert.deepEqual(config.provider, {});
		assert.deepEqual(config.promptContext, {});
	}));
});
