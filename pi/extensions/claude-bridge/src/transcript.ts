import type { Message } from "@earendil-works/pi-ai";

/** The user, assistant and toolResult messages of a transcript, in order.
 *  Pi 0.86+ carries the system prompt and the tool declarations as `system`
 *  messages in the same list. The bridge reads those through pi-ai's replay
 *  helpers (getCurrentSystemPrompt, getCurrentTools) and never counts them:
 *  cursors, prompt windows and fingerprints index conversation messages only,
 *  because the transcript the provider receives and
 *  SessionManager.buildSessionContext() need not hold the same number of
 *  system messages, and cursors persisted before 0.86 counted none. */
export function conversationMessages(messages: readonly Message[]): Message[] {
	return messages.filter((message) => message.role !== "system");
}
