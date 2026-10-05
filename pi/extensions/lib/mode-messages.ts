import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentMode, MODE_IDENTITIES } from "./agent-mode.ts";
import { FILE_TOOLS } from "./file-tools.ts";
import { PLAN_PATH, SUBMIT_PLAN } from "./plan-tools.ts";

export const MODE_MESSAGE_TYPE = "agent-mode-state";
// Sessions saved before explore mode recorded their snapshots under this type.
const LEGACY_MODE_MESSAGE_TYPE = "plan-mode-state";

export const SandboxStatus = { Active: "active", Inactive: "inactive" } as const;
export type SandboxStatus = (typeof SandboxStatus)[keyof typeof SandboxStatus];

export interface ModeSnapshot {
  mode: AgentMode;
  plansDirectory: string;
  sandbox: SandboxStatus;
  denials: readonly { name: string; note?: string }[];
}

export interface ModeMessages {
  announce(context: ExtensionContext): void;
  reset(): void;
}

// The system prompt and tool declarations stay fixed so switching modes keeps the provider's
// cache prefix; the mode reaches the model as appended snapshot messages instead, and a request
// that lost the latest snapshot (compaction, context edits) gets it re-appended at the end.
export function registerModeMessages(
  pi: Pick<ExtensionAPI, "on" | "sendMessage">,
  dependencies: {
    snapshot(): ModeSnapshot;
    projection(context: ExtensionContext): readonly unknown[];
    prepare(context: ExtensionContext): void;
  },
): ModeMessages {
  const { snapshot, projection, prepare } = dependencies;
  const delivery = createModeDelivery((content) =>
    pi.sendMessage(
      { customType: MODE_MESSAGE_TYPE, content, display: false },
      { triggerTurn: false },
    ),
  );

  pi.on("before_agent_start", async (_event, context) => {
    prepare(context);
    const content = delivery.initialMessage(renderSnapshot(snapshot()), projection(context));
    if (content === undefined) return undefined;
    return { message: { customType: MODE_MESSAGE_TYPE, content, display: false } };
  });

  pi.on("context", async (event, context) => {
    const messages = delivery.requestMessages(event.messages, renderSnapshot(snapshot()), projection(context));
    return messages === undefined ? undefined : { messages };
  });

  return {
    announce: (context) => delivery.announce(renderSnapshot(snapshot()), projection(context)),
    reset: delivery.reset,
  };
}

export function renderSnapshot({ mode, plansDirectory, sandbox, denials }: ModeSnapshot): string {
  const header = "This is the current agent-mode state. It supersedes all earlier agent-mode and plan-mode state messages.";
  if (mode === AgentMode.Execution) {
    return [
      header,
      "",
      "Plan mode and explore mode are off. The restrictions and instructions from earlier mode state messages no longer apply.",
      `${PLAN_PATH} and ${SUBMIT_PLAN} reject every call until the user enables plan mode again; do not call them.`,
      "The ordinary sandbox and path permissions still apply.",
    ].join("\n");
  }

  const { label } = MODE_IDENTITIES[mode];
  const planning = mode === AgentMode.Planning;
  const pathRules = planning ? "the read/write path rules" : "explore mode's own read/write path rules";
  return [
    header,
    "",
    planning ? "Plan mode is active." : "Explore mode is active. It exists for exploring the codebase before anything is implemented.",
    "",
    `- The file tools (${FILE_TOOLS.join(", ")}) check every path against ${pathRules}. Reading anywhere in the repository and in the memory, skill, plan and crit directories and the session's temp_dir works without asking.`,
    `- ${label} is read-only by default: writing inside the repository prompts the user for each path. The memory directory, the plans directory (${plansDirectory}) and the session's temp_dir stay writable.`,
    sandbox === SandboxStatus.Active
      ? "- bash runs in the sandbox, which enforces the same path rules at the OS level, so it needs no separate approval per call. A bash call with unsandboxed: true still needs the user's confirmation."
      : "- bash needs the user's approval for each call.",
    "- Other tools run without asking when they are read-only, exempt from approval in this mode, or granted by the user; every other tool asks the user before each call.",
    ...denialLines(denials),
    "- If a call or a path is denied, do not retry it and do not route around it.",
    planning
      ? `- To write a plan, call ${PLAN_PATH} once to get a file path, create the file there with write, and revise it with edit. An approved crit_review plan automatically opens the submission dialog; do not submit it again. Otherwise call ${SUBMIT_PLAN} with that path when it is ready. Only the user can leave plan mode.`
      : `- ${PLAN_PATH} and ${SUBMIT_PLAN} reject every call in explore mode; do not call them. There is nothing to submit: when the exploration is done, report what you found and stop. Only the user can leave explore mode.`,
  ].join("\n");
}

function denialLines(denials: ModeSnapshot["denials"]): string[] {
  if (denials.length === 0) return [];
  const sorted = [...denials].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return [
    "- The user denied these tools; calls to them are blocked:",
    ...sorted.map(({ name, note }) => (note ? `  - ${name} (do this instead: ${note})` : `  - ${name}`)),
  ];
}

export function createModeDelivery(send: (content: string) => void) {
  // Content handed to sendMessage that the session may not show yet: while the agent streams,
  // Pi holds custom messages until the tool results of the current turn are in.
  let queued: string | undefined;

  function observe(visible: readonly unknown[]): void {
    if (queued !== undefined && latestSnapshotContent(visible) === queued) queued = undefined;
  }

  function queue(content: string): void {
    send(content);
    queued = content;
  }

  return {
    announce(content: string, visible: readonly unknown[]): void {
      observe(visible);
      if ((queued ?? latestSnapshotContent(visible)) === content) return;
      queue(content);
    },

    // before_agent_start runs while idle, so anything queued earlier is either persisted or was
    // dropped with an aborted run; the session itself is the only reliable reference.
    initialMessage(content: string, visible: readonly unknown[]): string | undefined {
      const needed = latestSnapshotContent(visible) !== content;
      queued = needed ? content : undefined;
      return needed ? content : undefined;
    },

    requestMessages<Message>(messages: Message[], content: string, visible: readonly unknown[]): Message[] | undefined {
      observe(visible);
      if (latestSnapshotContent(messages) === content) return undefined;
      // The request-local copy covers this request; the durable copy keeps later requests from
      // needing the fallback, unless the session already has it and only this request lost it.
      if (latestSnapshotContent(visible) !== content && queued !== content) queue(content);
      return [...messages, snapshotMessage(content) as Message];
    },

    reset(): void {
      queued = undefined;
    },
  };
}

export function latestSnapshotContent(messages: readonly unknown[]): string | undefined {
  const latest = (messages as readonly { role?: unknown; customType?: unknown; content?: unknown }[]).findLast(
    (message) => message.role === "custom" && (message.customType === MODE_MESSAGE_TYPE || message.customType === LEGACY_MODE_MESSAGE_TYPE),
  );
  return latest === undefined ? undefined : normalizedContent(latest.content);
}

function normalizedContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function snapshotMessage(content: string) {
  return { role: "custom", customType: MODE_MESSAGE_TYPE, content, display: false, timestamp: Date.now() };
}
