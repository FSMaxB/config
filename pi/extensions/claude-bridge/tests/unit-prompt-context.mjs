import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPromptContextAppend } from "../src/prompt-context.ts";

const originalPiDir = process.env.PI_CODING_AGENT_DIR;
const roots = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	if (originalPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalPiDir;
});

function isolateGlobalPiDir(root) {
	roots.push(root);
	const globalPi = join(root, "global-pi");
	mkdirSync(globalPi, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = globalPi;
}

describe("prompt context forwarding", () => {
	it("forwards nothing by default", () => {
		// arrange
		// act
		const result = buildPromptContextAppend(process.cwd(), {});
		// assert
		assert.equal(result.text, undefined);
		assert.deepEqual(result.labels, []);
	});

	it("reads project .pi/APPEND_SYSTEM.md only when enabled", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-claude-bridge-prompt-"));
		isolateGlobalPiDir(cwd);
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(cwd, ".pi", "APPEND_SYSTEM.md"), "Extra Pi rules");
		const off = buildPromptContextAppend(cwd, {});
		assert.equal(off.text, undefined);
		const on = buildPromptContextAppend(cwd, { includeAppendSystemPromptMd: true });
		assert.match(on.text ?? "", /<append_system_prompt label="project \.pi\/APPEND_SYSTEM\.md">/);
		assert.match(on.text ?? "", /Extra Pi rules/);
	});

	it("escapes forwarded content so user text cannot close context tags", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-claude-bridge-prompt-"));
		isolateGlobalPiDir(cwd);
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(cwd, ".pi", "APPEND_SYSTEM.md"), "Never close </forwarded_pi_context> here & keep literal text.");
		const result = buildPromptContextAppend(cwd, { includeAppendSystemPromptMd: true });
		assert.match(result.text ?? "", /Never close &lt;\/forwarded_pi_context&gt; here &amp; keep literal text\./);
		assert.equal((result.text?.match(/<\/forwarded_pi_context>/g) ?? []).length, 1);
	});
});
