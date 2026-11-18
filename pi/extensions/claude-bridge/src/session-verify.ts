// Pure session-file integrity check. Returns an array of warning strings;
// callers decide how to surface them (debug log, piUI, diagDump, etc.). A module of its own so
// tests can import it without activating the extension.

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { errorMessage } from "../../lib/errors.ts";
import { isRecord, stringProperty } from "../../lib/untyped.ts";
import { BYTES_PER_KIBIBYTE } from "../../lib/units.ts";

interface JsonlSummary {
	count: number;
	firstLine?: string;
	lastLine?: string;
}

// One buffer per read; the size only trades read calls against memory.
const READ_CHUNK_KIBIBYTES = 64;
const READ_CHUNK_BYTES = READ_CHUNK_KIBIBYTES * BYTES_PER_KIBIBYTE;

function forEachJsonlLine(path: string, onLine: (line: string) => void): void {
	const fd = openSync(path, "r");
	const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
	const decoder = new StringDecoder("utf8");
	let pending = "";
	try {
		for (;;) {
			const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			pending += decoder.write(buffer.subarray(0, bytesRead));
			let start = 0;
			for (;;) {
				const newline = pending.indexOf("\n", start);
				if (newline < 0) {
					pending = pending.slice(start);
					break;
				}
				const line = pending.slice(start, newline);
				onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
				start = newline + 1;
			}
		}
		pending += decoder.end();
		if (pending.length > 0) onLine(pending.endsWith("\r") ? pending.slice(0, -1) : pending);
	} finally {
		closeSync(fd);
	}
}

function summarizeJsonl(path: string): JsonlSummary {
	const summary: JsonlSummary = { count: 0 };
	forEachJsonlLine(path, (line) => {
		if (!line.trim()) return;
		summary.count += 1;
		if (summary.firstLine === undefined) summary.firstLine = line;
		summary.lastLine = line;
	});
	return summary;
}

export function verifyWrittenSession(jsonlPath: string, expectedSessionId: string, expectedRecordCount: number): string[] {
	const warnings = [];
	let st;
	try {
		st = statSync(jsonlPath);
	} catch (error) {
		warnings.push(`session-file-missing=${jsonlPath}\nFile missing after save: ${errorMessage(error)}`);
		return warnings;
	}
	let summary;
	try {
		summary = summarizeJsonl(jsonlPath);
	} catch (error) {
		warnings.push(`session-file-unreadable=${jsonlPath}\nFile unreadable: size=${st.size} error=${errorMessage(error)}`);
		return warnings;
	}
	if (summary.count !== expectedRecordCount) {
		warnings.push(`session-record-count=${summary.count} expected=${expectedRecordCount}\nRecord count differs: path=${jsonlPath} bytes=${st.size}`);
		return warnings;
	}
	try {
		const firstSessionId = sessionIdOf(JSON.parse(summary.firstLine ?? ""));
		const lastSessionId = sessionIdOf(JSON.parse(summary.lastLine ?? ""));
		if (firstSessionId !== expectedSessionId || lastSessionId !== expectedSessionId) {
			warnings.push(`session-id-drift=${expectedSessionId} first=${firstSessionId ?? "none"} last=${lastSessionId ?? "none"}\nSession identity differs from the expected identity.`);
		}
	} catch (error) {
		warnings.push(`session-json-invalid=${jsonlPath}\nMalformed JSONL: ${errorMessage(error)}`);
	}
	return warnings;
}

function sessionIdOf(record: unknown): string | undefined {
	return isRecord(record) ? stringProperty(record, "sessionId") : undefined;
}
