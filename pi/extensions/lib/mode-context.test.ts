import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentMode } from "./agent-mode.ts";
import {
  latestSnapshotContent,
  registerModeMessages,
  renderSnapshot,
  SandboxStatus,
  type ModeSnapshot,
} from "./mode-messages.ts";

test("the first prompt receives the current snapshot and unchanged prompts do not repeat it", async () => {
  for (const mode of [AgentMode.Planning, AgentMode.Exploring, AgentMode.Execution]) {
    // arrange
    const fixture = fakeSession({ mode });

    // act
    const first = await fixture.prompt("one");
    const second = await fixture.prompt("two");

    // assert
    assert.equal(latestSnapshotContent(first), fixture.current());
    assert.equal(snapshotCount(second), 1);
    assert.deepEqual(second.slice(0, first.length), first);
  }
});

test("before_agent_start only adds a hidden message and never touches the prompt", async () => {
  // arrange
  const fixture = fakeSession({ mode: AgentMode.Planning });

  // act
  const result = await fixture.handlers.before_agent_start({ systemPrompt: "base" }, fixture.context);

  // assert
  assert.deepEqual(Object.keys(result ?? {}), ["message"]);
  assert.deepEqual(result?.message, { customType: "agent-mode-state", content: fixture.current(), display: false });
});

test("a persisted legacy snapshot with the current content is not repeated", async () => {
  // arrange
  const fixture = fakeSession({ mode: AgentMode.Planning });
  fixture.persisted.push({ role: "custom", customType: "plan-mode-state", content: fixture.current(), display: false });

  // act
  const request = await fixture.prompt("continue");

  // assert
  assert.equal(latestSnapshotContent(request), fixture.current());
  assert.equal(snapshotCount(request), 0);
  assert.equal(fixture.sent.length, 0);
});

test("idle toggles append snapshots and keep every earlier request as a prefix", async () => {
  // arrange
  const fixture = fakeSession({ mode: AgentMode.Execution });
  const baseline = await fixture.prompt("baseline");

  // act
  fixture.transition({ mode: AgentMode.Planning });
  const planning = await fixture.prompt("planning");
  fixture.transition({ mode: AgentMode.Execution });
  const execution = await fixture.prompt("execution");
  fixture.transition({ mode: AgentMode.Planning });
  const again = await fixture.prompt("again");

  // assert
  assert.deepEqual(planning.slice(0, baseline.length), baseline);
  assert.deepEqual(execution.slice(0, planning.length), planning);
  assert.deepEqual(again.slice(0, execution.length), execution);
  assert.equal(latestSnapshotContent(planning), fixture.render({ mode: AgentMode.Planning }));
  assert.equal(latestSnapshotContent(execution), fixture.render({ mode: AgentMode.Execution }));
  assert.equal(latestSnapshotContent(again), fixture.render({ mode: AgentMode.Planning }));
  assert.equal(snapshotCount(again), 4);
});

test("transitions inside a tool batch are queued behind the tool results, all of them in order", async () => {
  // arrange
  const fixture = fakeSession({ mode: AgentMode.Execution });
  await fixture.prompt("start");

  // act
  const continuation = await fixture.toolBatch(() => {
    fixture.transition({ mode: AgentMode.Planning });
    fixture.transition({ mode: AgentMode.Execution });
  });

  // assert
  const roles = continuation.map((message) => message.role);
  const call = roles.lastIndexOf("assistant");
  assert.equal(roles[call + 1], "toolResult");
  const queued = continuation.slice(call + 2).map((message) => message.content);
  assert.deepEqual(queued, [fixture.render({ mode: AgentMode.Planning }), fixture.render({ mode: AgentMode.Execution })]);
  assert.deepEqual(fixture.sent.map(({ options }) => options), [{ triggerTurn: false }, { triggerTurn: false }]);
});

test("approval inside a tool call puts the execution snapshot before the continuation", async () => {
  // arrange
  const fixture = fakeSession({ mode: AgentMode.Planning });
  const planning = await fixture.prompt("plan it");

  // act
  const continuation = await fixture.toolBatch(() => fixture.transition({ mode: AgentMode.Execution }));
  const followUp = await fixture.prompt("implement");

  // assert
  assert.deepEqual(continuation.slice(0, planning.length), planning);
  assert.equal(latestSnapshotContent(continuation), fixture.render({ mode: AgentMode.Execution }));
  assert.equal(continuation.at(-1)?.customType, "agent-mode-state");
  assert.equal(snapshotCount(followUp), 2);
});

test("denial and note changes announce a new snapshot, decisions that render the same do not", async () => {
  // arrange
  const fixture = fakeSession({ mode: AgentMode.Planning });
  await fixture.prompt("start");

  // act
  fixture.transition({});
  const unchanged = fixture.sent.length;
  fixture.transition({ denials: [{ name: "bash" }] });
  fixture.transition({ denials: [{ name: "bash", note: "Ask first" }] });

  // assert
  assert.equal(unchanged, 0);
  assert.deepEqual(fixture.sent.map(({ message }) => message.content), [
    fixture.render({ denials: [{ name: "bash" }] }),
    fixture.render({ denials: [{ name: "bash", note: "Ask first" }] }),
  ]);
});

test("a removed snapshot is restored at the end of the request and persisted once", async () => {
  // arrange
  const fixture = fakeSession({ mode: AgentMode.Planning });
  await fixture.prompt("start");
  fixture.compact();

  // act
  const restored = await fixture.prompt("after compaction");
  const later = await fixture.prompt("later");

  // assert
  assert.equal(latestSnapshotContent(restored), fixture.current());
  assert.equal(fixture.sent.length, 0);
  assert.equal(latestSnapshotContent(later), fixture.current());
  assert.equal(snapshotCount(later), 1);
});

test("compaction between before_agent_start and the request still yields current instructions", async () => {
  // arrange
  const fixture = fakeSession({ mode: AgentMode.Planning });
  await fixture.prompt("start");
  fixture.streaming = true;
  await fixture.startPrompt("next");
  fixture.compact();
  const compacted = structuredClone(fixture.persisted);

  // act
  const request = await fixture.request();
  fixture.flush();
  const continuation = await fixture.request();

  // assert
  assert.deepEqual(request.slice(0, -1), compacted);
  assert.equal(request.at(-1)?.content, fixture.current());
  assert.equal(fixture.sent.length, 1);
  assert.deepEqual(continuation, fixture.persisted);
  assert.equal(latestSnapshotContent(continuation), fixture.current());
});

test("repeated compactions restore the snapshot every time", async () => {
  // arrange
  const fixture = fakeSession({ mode: AgentMode.Planning });
  await fixture.prompt("start");

  // act
  const restorations: unknown[] = [];
  for (let round = 0; round < 3; round += 1) {
    fixture.compact();
    const continuation = await fixture.toolBatch(() => undefined);
    restorations.push(latestSnapshotContent(fixture.requests.at(-2) ?? []), latestSnapshotContent(continuation));
  }

  // assert
  assert.deepEqual(restorations, Array(6).fill(fixture.current()));
  assert.equal(fixture.sent.length, 3);
});

test("a durable copy dropped by an abort leaves the fallback in place until the next prompt persists it", async () => {
  // arrange
  const fixture = fakeSession({ mode: AgentMode.Planning });
  await fixture.prompt("start");
  fixture.compact();
  fixture.streaming = true;

  // act
  const aborted = await fixture.request();
  fixture.abort();
  const retry = await fixture.request();
  const next = await fixture.prompt("next");

  // assert
  assert.equal(latestSnapshotContent(aborted), fixture.current());
  assert.equal(latestSnapshotContent(retry), fixture.current());
  assert.equal(fixture.sent.length, 1);
  assert.equal(next.at(-1)?.customType, "agent-mode-state");
  assert.equal(snapshotCount(next), 1);
});

test("an obsolete snapshot left behind after compaction is superseded, not trusted", async () => {
  // arrange
  const fixture = fakeSession({ mode: AgentMode.Planning });
  await fixture.prompt("start");
  fixture.transition({ mode: AgentMode.Execution });
  fixture.persisted = fixture.persisted.filter(
    (message) => message.content !== fixture.render({ mode: AgentMode.Execution }),
  );

  // act
  const request = await fixture.prompt("after edit");

  // assert
  assert.equal(latestSnapshotContent(request), fixture.render({ mode: AgentMode.Execution }));
  assert.equal(snapshotCount(request), 2);
});

test("reset compares the next branch on its own", async () => {
  // arrange
  const fixture = fakeSession({ mode: AgentMode.Planning });
  await fixture.prompt("start");
  fixture.streaming = true;
  fixture.transition({ mode: AgentMode.Execution });
  fixture.abort();
  fixture.persisted = [];

  // act
  fixture.messages.reset();
  fixture.transition({});

  // assert
  assert.equal(fixture.sent.length, 2);
  assert.equal(latestSnapshotContent(fixture.persisted), fixture.render({ mode: AgentMode.Execution }));
});

test("the prepare hook runs before the snapshot is computed", async () => {
  // arrange
  const fixture = fakeSession({ mode: AgentMode.Execution }, (state) => {
    state.mode = AgentMode.Planning;
  });

  // act
  const request = await fixture.prompt("start");

  // assert
  assert.equal(latestSnapshotContent(request), fixture.render({ mode: AgentMode.Planning }));
});

interface Message {
  role: string;
  customType?: string;
  content?: unknown;
  display?: boolean;
}

// Mirrors the parts of Pi's session the hooks depend on: custom messages sent while streaming
// wait for the tool results, requests are built from the persisted messages, and the fake API
// has no setActiveTools or prompt access, so touching them would throw.
function fakeSession(initial: Partial<ModeSnapshot>, prepare: (state: ModeSnapshot) => void = () => undefined) {
  const state: ModeSnapshot = { ...baseSnapshot(), ...initial };
  const handlers: Record<string, (event: any, context: ExtensionContext) => Promise<any>> = {};
  const sent: { message: Message; options: unknown }[] = [];
  const context = {} as ExtensionContext;
  const fixture = {
    state,
    handlers,
    sent,
    context,
    persisted: [] as Message[],
    pending: [] as Message[],
    requests: [] as Message[][],
    streaming: false,
    messages: undefined as unknown as ReturnType<typeof registerModeMessages>,

    current: () => renderSnapshot(state),
    render: (overrides: Partial<ModeSnapshot>) => renderSnapshot({ ...state, ...overrides }),

    transition(changes: Partial<ModeSnapshot>) {
      Object.assign(state, changes);
      fixture.messages.announce(context);
    },

    async startPrompt(text: string) {
      const result = await handlers.before_agent_start({ prompt: text, systemPrompt: "base" }, context);
      fixture.persisted.push({ role: "user", content: text });
      if (result?.message) fixture.persisted.push({ role: "custom", ...result.message });
    },

    async request(): Promise<Message[]> {
      const messages = structuredClone(fixture.persisted);
      const result = await handlers.context({ type: "context", messages }, context);
      const request = result?.messages ?? messages;
      fixture.requests.push(request);
      return request;
    },

    async prompt(text: string): Promise<Message[]> {
      await fixture.startPrompt(text);
      const request = await fixture.request();
      fixture.persisted.push({ role: "assistant", content: "ok" });
      return request;
    },

    async toolBatch(during: () => void): Promise<Message[]> {
      fixture.streaming = true;
      await fixture.request();
      fixture.persisted.push({ role: "assistant", content: [{ type: "toolCall", name: "submit_plan" }] });
      during();
      fixture.persisted.push({ role: "toolResult", content: "done" });
      fixture.flush();
      const continuation = await fixture.request();
      fixture.persisted.push({ role: "assistant", content: "ok" });
      fixture.streaming = false;
      return continuation;
    },

    flush() {
      fixture.persisted.push(...fixture.pending);
      fixture.pending = [];
    },

    abort() {
      fixture.pending = [];
      fixture.streaming = false;
    },

    // Keeps only the latest user prompt, the way a compaction that cut the snapshot would.
    compact() {
      const kept = fixture.persisted.filter((message) => message.role === "user").slice(-1);
      fixture.persisted = [{ role: "compactionSummary", content: "Plan mode is active. Old summary." }, ...kept];
    },
  };

  fixture.messages = registerModeMessages(
    {
      on: ((event: string, handler: (typeof handlers)[string]) => {
        handlers[event] = handler;
      }) as never,
      sendMessage: ((message: Omit<Message, "role">, options: unknown) => {
        const custom = { role: "custom", ...message };
        sent.push({ message: custom, options });
        if (fixture.streaming) fixture.pending.push(custom);
        else fixture.persisted.push(custom);
      }) as never,
    },
    {
      snapshot: () => ({ ...state }),
      projection: () => fixture.persisted,
      prepare: () => prepare(state),
    },
  );
  return fixture;
}

function baseSnapshot(): ModeSnapshot {
  return { mode: AgentMode.Planning, plansDirectory: "/plans", sandbox: SandboxStatus.Active, denials: [] };
}

function snapshotCount(messages: Message[]): number {
  return messages.filter((message) => message.customType === "agent-mode-state").length;
}
