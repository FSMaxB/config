import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { isolatedFromEnv, piUserDir } from "./config.js";
import { debug } from "./debug.js";

export interface PromptContextSettings {
	includeAppendSystemPromptMd?: boolean;

}

export interface PromptContextAppend {
	text?: string;
	labels: string[];
}

function readTrimmed(path: string): string | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const content = readFileSync(path, "utf8").trim();
		return content.length > 0 ? content : undefined;
	} catch (error) {
		// The file exists but could not be read: the user opted into forwarding
		// it, so a silent drop looks like the setting being ignored.
		debug(`prompt-context: failed to read ${path}:`, error instanceof Error ? error.message : String(error));
		return undefined;
	}
}

function findProjectAppendSystem(startDir: string): string | undefined {
	let current = resolve(startDir);
	while (true) {
		const candidate = join(current, ".pi", "APPEND_SYSTEM.md");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return undefined;
}

export function readAppendSystemPromptFiles(cwd: string): Array<{ label: string; content: string }> {
	const files: Array<{ label: string; path: string }> = [
		{ label: "global APPEND_SYSTEM.md", path: join(piUserDir(), "APPEND_SYSTEM.md") },
	];
	// Isolated mode: no cwd-ancestor discovery — the host app owns the prompt surface.
	const projectPath = isolatedFromEnv() ? undefined : findProjectAppendSystem(cwd);
	if (projectPath) files.push({ label: "project .pi/APPEND_SYSTEM.md", path: projectPath });

	const seen = new Set<string>();
	const output: Array<{ label: string; content: string }> = [];
	for (const file of files) {
		if (seen.has(file.path)) continue;
		seen.add(file.path);
		const content = readTrimmed(file.path);
		if (content) output.push({ label: file.label, content });
	}
	return output;
}

export function buildPromptContextAppend(cwd: string, settings: PromptContextSettings): PromptContextAppend {
	const parts: string[] = [];
	const labels: string[] = [];

	if (settings.includeAppendSystemPromptMd) {
		for (const file of readAppendSystemPromptFiles(cwd)) {
			parts.push(xmlBlock("append_system_prompt", { label: file.label }, file.content));
			labels.push(file.label);
		}
	}







	if (parts.length === 0) return { labels };
	return {
		labels,
		text: xmlBlock(
			"forwarded_pi_context",
			{},
			[
				"The following content was explicitly enabled in pi-claude-bridge settings and comes from Pi prompt files.",
				...parts,
			].join("\n\n"),
			false,
		),
	};
}

function escapeXmlAttr(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function escapeXmlText(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function xmlBlock(tag: string, attrs: Record<string, string>, content: string, escapeContent = true): string {
	const attrText = Object.entries(attrs)
		.map(([key, value]) => ` ${key}="${escapeXmlAttr(value)}"`)
		.join("");
	const body = escapeContent ? escapeXmlText(content.trim()) : content.trim();
	return `<${tag}${attrText}>\n${body}\n</${tag}>`;
}
