#!/usr/bin/env node
// Checks the SDK behaviour the tree-resume path relies on. Needs a logged-in
// Claude Code and network; prints a JSON summary and exits 1 on a failed check.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { openSession } from "cc-session-io";

const cwd = process.cwd();
const claudeDir = process.env.CLAUDE_CONFIG_DIR;
const base = { cwd, model: "claude-haiku-4-5", permissionMode: "bypassPermissions", tools: [], allowedTools: [], includePartialMessages: false };

async function run(prompt, options) {
	const out = { sessionId: undefined, assistantMessageIds: [], text: "", cacheRead: 0, cacheWrite: 0, input: 0 };
	for await (const message of query({ prompt, options: { ...base, ...options } })) {
		if (message.type === "system" && message.subtype === "init") out.sessionId = message.session_id;
		if (message.type === "assistant") out.assistantMessageIds.push(message.message.id);
		if (message.type === "result") {
			out.text = message.subtype === "success" ? message.result : `ERROR ${message.subtype}: ${message.errors?.join("; ")}`;
			out.cacheRead = message.usage?.cache_read_input_tokens ?? 0;
			out.cacheWrite = message.usage?.cache_creation_input_tokens ?? 0;
			out.input = message.usage?.input_tokens ?? 0;
		}
	}
	return out;
}

function lastRecordOfMessage(sessionId, messageId) {
	const session = openSession({ sessionId, projectPath: cwd, claudeDir });
	const records = session.messages.filter((record) => record.type === "assistant" && record.message?.id === messageId);
	return { uuid: records.at(-1)?.uuid, isTail: session.messages.at(-1)?.uuid === records.at(-1)?.uuid, count: records.length, total: session.messages.length };
}

const failures = [];
const check = (name, ok) => { if (!ok) failures.push(name); };

// Haiku only caches prompts of 4096+ tokens, so pad the first turn well past that.
const padding = Array.from({ length: 400 }, (_, index) => `Filler line ${index}: the quick brown fox jumps over the lazy dog.`).join("\n");
const q1 = await run(`${padding}\n\nThe secret word is apple. Reply with OK only.`, {});
const fork = lastRecordOfMessage(q1.sessionId, q1.assistantMessageIds.at(-1));
check("q1 assistant record found in transcript", fork.uuid !== undefined);
check("q1 assistant record is the transcript tail", fork.isTail);
const q2 = await run("The secret word is now banana. Reply with OK only.", { resume: q1.sessionId });
const transcriptLength = (sessionId) => openSession({ sessionId, projectPath: cwd, claudeDir }).messages.length;
const q1TranscriptBeforeFork = transcriptLength(q1.sessionId);
const q3 = await run("What is the secret word? Answer with one word.", { resume: q1.sessionId, resumeSessionAt: fork.uuid, forkSession: true });
check("q3 got a new session id", q3.sessionId !== undefined && q3.sessionId !== q1.sessionId);
check("q3 answers apple", /apple/i.test(q3.text) && !/banana/i.test(q3.text));
check("q3 read the prompt cache", q3.cacheRead > 0);
const q4 = await run("Repeat the secret word.", { resume: q3.sessionId });
check("q4 still answers apple", /apple/i.test(q4.text));
check("q4 read the prompt cache", q4.cacheRead > 0);
const q1Transcript = transcriptLength(q1.sessionId);
check("q2 appended to the q1 transcript", q1TranscriptBeforeFork > fork.total);
check("q1 transcript untouched by the fork", q1Transcript === q1TranscriptBeforeFork);

console.log(JSON.stringify({ q1, fork, q2, q3, q4, q1TranscriptMessagesAfterFork: q1Transcript, failures }, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
