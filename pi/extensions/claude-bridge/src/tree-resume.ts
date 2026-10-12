import type { Message } from "@earendil-works/pi-ai";
import type { SessionProjection } from "@earendil-works/pi-coding-agent";
import { openSession } from "cc-session-io";
import { statSync } from "fs";
import { PROVIDER_ID } from "./convert.js";
import { type ClaudeTranscriptAnchor, type StampedAssistantMessage } from "./query-state.js";
import { conversationMessages } from "./transcript.js";

/** A /tree target the bridge can resume instead of rebuilding: the Claude
 *  transcript position stamped on the last message of the new branch, plus the
 *  branch's conversation for the record's cursor and fingerprint. */
export interface TreeResumeTarget extends ClaudeTranscriptAnchor {
	conversation: Message[];
}

/** Why a branch cannot be resumed and has to rebuild (debug log only). */
export type TreeResumeRejection = string;

export function findTreeResumeTarget(projection: Pick<SessionProjection, "entries" | "messages">): TreeResumeTarget | TreeResumeRejection {
	const lastProjected = projection.entries.filter((entry) => entry.messages.length > 0).at(-1);
	if (!lastProjected) return "the branch has no messages";
	if (lastProjected.sourceEntry.type !== "message") return `the branch ends with a ${lastProjected.sourceEntry.type} entry`;
	const message = lastProjected.messages.at(-1) as StampedAssistantMessage | { role: string };
	if (message.role !== "assistant") return `the branch ends with a ${message.role} message`;
	const assistant = message as StampedAssistantMessage;
	if (assistant.provider !== PROVIDER_ID) return `the last message came from ${assistant.provider}`;
	if (!assistant.claudeBridge?.sessionId || !assistant.claudeBridge.messageId) return "the last message carries no Claude transcript anchor";
	if (assistant.stopReason !== "stop") return `the last message stopped with ${assistant.stopReason}`;
	if (assistant.content.some((block) => block.type === "toolCall")) return "the last message calls tools";
	const { sessionId, messageId } = assistant.claudeBridge;
	return { sessionId, messageId, conversation: conversationMessages(projection.messages as Message[]) };
}

export interface ForkPoint {
	uuid: string;
	/** The record is the transcript's last message: a plain resume reaches it, no fork needed. */
	isTail: boolean;
}

/** Locate the stamped message in the Claude transcript. The LAST assistant
 *  record with that API message id is the fork point: Claude Code writes one
 *  record per content block, and the SDK forks at the kept turn's last chain
 *  entry. A transcript rebuilt from Pi history carries synthetic ids and never
 *  matches, which is the point: its records are not the ones the stamp meant. */
export function resolveForkPoint(target: ClaudeTranscriptAnchor, cwd: string, claudeDir: string | undefined): ForkPoint | TreeResumeRejection {
	let session: ReturnType<typeof openSession>;
	try {
		session = openSession({ sessionId: target.sessionId, projectPath: cwd, claudeDir });
		statSync(session.jsonlPath);
	} catch (error) {
		return `Claude session ${target.sessionId.slice(0, 8)} cannot be read: ${error instanceof Error ? error.message : String(error)}`;
	}
	const record = session.messages.filter((candidate) => candidate.type === "assistant" && candidate.message?.id === target.messageId).at(-1);
	if (!record) return `message ${target.messageId} is not in Claude session ${target.sessionId.slice(0, 8)}`;
	return { uuid: record.uuid, isTail: session.messages.at(-1)?.uuid === record.uuid };
}
