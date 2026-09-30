import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { it } from "node:test";

it("verifies tool APIs in an isolated offline Pi process", async () => {
	// arrange
	const home = await mkdtemp(join(tmpdir(), "pi-tool-api-home-"));
	const agentDir = join(home, ".pi", "agent");
	await mkdir(agentDir, { recursive: true });
	const environment = { ...process.env };
	delete environment.NODE_TEST_CONTEXT;
	delete environment.PI_SUBAGENT_PATH_POLICY;
	delete environment.PI_SESSION_TEMP_DIR;
	try {
		// act
		const { stdout, stderr } = await promisify(execFile)(process.execPath,
			["--import", "tsx", "--test", "--test-reporter=tap", "tests/lib/tool-api-cases.mjs"], {
				cwd: new URL("..", import.meta.url), timeout: 120000, maxBuffer: 4 * 1024 * 1024,
				env: { ...environment, HOME: home, PI_CODING_AGENT_DIR: agentDir,
					PI_SUBAGENT_CHILD: "", PI_SUBAGENT_PLAN_ALLOWED_TOOLS: "",
					CLAUDE_BRIDGE_ISOLATED: "1" },
			});
		// assert
		assert.match(stdout, /fail 0/);
		assert.equal(stderr, "");
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
