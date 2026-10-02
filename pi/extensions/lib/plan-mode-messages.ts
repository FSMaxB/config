import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FILE_TOOLS } from "./file-tools.ts";

export const PLAN_PATH = "plan_path";
export const SUBMIT_PLAN = "submit_plan";
export const PLAN_TOOLS = [PLAN_PATH, SUBMIT_PLAN];
export const PLAN_MODE_MESSAGE_TYPE = "plan-mode-state";

export const PlanModeState = { Planning: "planning", Execution: "execution" } as const;
export type PlanModeState = (typeof PlanModeState)[keyof typeof PlanModeState];
export const SandboxStatus = { Active: "active", Inactive: "inactive" } as const;
export type SandboxStatus = (typeof SandboxStatus)[keyof typeof SandboxStatus];

export interface PlanModeSnapshot {
  mode: PlanModeState;
  plansDirectory: string;
  sandbox: SandboxStatus;
  denials: readonly { name: string; note?: string }[];
}

export interface PlanModeMessages {
  announce(context: ExtensionContext): void;
  reset(): void;
}

// The system prompt and tool declarations stay fixed so toggling plan mode keeps the provider's
// cache prefix; the mode reaches the model as appended snapshot messages instead, and a request
// that lost the latest snapshot (compaction, context edits) gets it re-appended at the end.
export function registerPlanModeMessages(
  pi: Pick<ExtensionAPI, "on" | "sendMessage">,
  dependencies: {
    snapshot(): PlanModeSnapshot;
    projection(context: ExtensionContext): readonly unknown[];
    prepare(context: ExtensionContext): void;
  },
): PlanModeMessages {
  const { snapshot, projection, prepare } = dependencies;
  const delivery = createPlanModeDelivery((content) =>
    pi.sendMessage(
      { customType: PLAN_MODE_MESSAGE_TYPE, content, display: false },
      { triggerTurn: false },
    ),
  );

  pi.on("before_agent_start", async (_event, context) => {
    prepare(context);
    const content = delivery.initialMessage(renderSnapshot(snapshot()), projection(context));
    if (content === undefined) return undefined;
    return { message: { customType: PLAN_MODE_MESSAGE_TYPE, content, display: false } };
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

// Sessions saved while plan mode was off may restore a loadout without the planning tools.
// Only missing ones are appended, so unrelated tools keep their order.
export function activateMissingPlanTools(pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">): void {
  const active = pi.getActiveTools();
  const missing = PLAN_TOOLS.filter((name) => !active.includes(name));
  if (missing.length > 0) pi.setActiveTools([...active, ...missing]);
}

export function renderSnapshot({ mode, plansDirectory, sandbox, denials }: PlanModeSnapshot): string {
  const header = "This is the current plan-mode state. It supersedes all earlier plan-mode state messages.";
  if (mode === PlanModeState.Execution) {
    return [
      header,
      "",
      "Plan mode is off. The planning restrictions and instructions from earlier plan-mode state messages no longer apply.",
      `${PLAN_PATH} and ${SUBMIT_PLAN} reject every call until the user enables plan mode again; do not call them.`,
      "The ordinary sandbox and path permissions still apply.",
    ].join("\n");
  }

  return [
    header,
    "",
    "Plan mode is active.",
    "",
    `- The file tools (${FILE_TOOLS.join(", ")}) check every path against the read/write path rules. Reading anywhere in the repository and in the memory, skill, plan and crit directories and the session's temp_dir works without asking.`,
    `- Plan mode is read-only by default: writing inside the repository prompts the user for each path. The memory directory, the plans directory (${plansDirectory}) and the session's temp_dir stay writable.`,
    sandbox === SandboxStatus.Active
      ? "- bash runs in the sandbox, which enforces the same path rules at the OS level, so it needs no separate plan-mode approval per call. A bash call with unsandboxed: true still needs the user's confirmation."
      : "- bash needs the user's approval for each call.",
    "- Other tools run without asking when they are read-only, exempt from plan-mode approval, or granted by the user; every other tool asks the user before each call.",
    ...denialLines(denials),
    "- If a call or a path is denied, do not retry it and do not route around it.",
    `- To write a plan, call ${PLAN_PATH} once to get a file path, create the file there with write, and revise it with edit. An approved crit_review plan automatically opens the submission dialog; do not submit it again. Otherwise call ${SUBMIT_PLAN} with that path when it is ready. Only the user can leave plan mode.`,
  ].join("\n");
}

function denialLines(denials: PlanModeSnapshot["denials"]): string[] {
  if (denials.length === 0) return [];
  const sorted = [...denials].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return [
    "- The user denied these tools; calls to them are blocked:",
    ...sorted.map(({ name, note }) => (note ? `  - ${name} (do this instead: ${note})` : `  - ${name}`)),
  ];
}

export function createPlanModeDelivery(send: (content: string) => void) {
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
    (message) => message.role === "custom" && message.customType === PLAN_MODE_MESSAGE_TYPE,
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
  return { role: "custom", customType: PLAN_MODE_MESSAGE_TYPE, content, display: false, timestamp: Date.now() };
}
