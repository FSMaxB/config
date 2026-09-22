export function collectContextMessages<Entry, Message>(
  sessionManager: {
    buildContextEntries(): Entry[];
    buildSessionProjection?: () => { messages: Message[] };
  },
  convertEntry: (entry: Entry) => Message[],
): Message[] {
  // Projection replays context edits; older Pi versions only expose raw entries.
  if (typeof sessionManager.buildSessionProjection === "function") {
    return sessionManager.buildSessionProjection().messages;
  }
  return sessionManager.buildContextEntries().flatMap(convertEntry);
}

export function splitContextMessages<Message extends { role: string }>(
  messages: Message[],
): { messages: Message[]; systemMessages: TranscriptSystemMessage[] } {
  return {
    messages: messages.filter((message) => message.role !== "system"),
    systemMessages: messages.filter(
      (message) => message.role === "system",
    ) as unknown as TranscriptSystemMessage[],
  };
}

export function measureTranscriptSystem(messages: TranscriptSystemMessage[]) {
  let instructionCharacters = 0;
  let toolCharacters = 0;
  let toolDeclarations = 0;
  for (const message of messages) {
    instructionCharacters +=
      typeof message.content === "string"
        ? message.content.length
        : (message.content ?? []).reduce(
            (sum, block) => sum + block.text.length,
            0,
          );
    if (message.sections) {
      instructionCharacters += JSON.stringify(message.sections).length;
    }
    for (const tool of message.toolsAdded ?? []) {
      toolCharacters += JSON.stringify(tool).length;
      toolDeclarations += 1;
    }
    if (message.toolsRemoved?.length) {
      toolCharacters += JSON.stringify(message.toolsRemoved).length;
    }
  }
  return { instructionCharacters, toolCharacters, toolDeclarations };
}

interface TranscriptSystemMessage {
  role: "system";
  content?: string | { type: "text"; text: string }[];
  sections?: Record<string, string | null>;
  toolsAdded?: unknown[];
  toolsRemoved?: unknown[];
}
