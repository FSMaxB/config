#!/usr/bin/env node
// Context continuity test for pi-claude-bridge provider.
// Verifies that switching away from the provider and back correctly
// preserves conversation context (all messages are flattened into
// each query, so "missed" messages are automatically included).
//
// Requires: pi CLI, Claude Code (for Agent SDK subprocess).
// Requires: CLAUDE_BRIDGE_TESTING_ALT_PROVIDER (e.g. "minimax")
// Requires: CLAUDE_BRIDGE_TESTING_ALT_MODEL (e.g. "MiniMax-M2.7-highspeed")

console.log("test=session-resume");

import { readFileSync } from "node:fs";
import { createRpcHarness, requireEnv } from "./lib/rpc-harness.mjs";

const OTHER_PROVIDER = requireEnv("CLAUDE_BRIDGE_TESTING_ALT_PROVIDER");
const OTHER_MODEL = requireEnv("CLAUDE_BRIDGE_TESTING_ALT_MODEL");

const TIMEOUT = 180_000;
const BRIDGE_MODEL = "pi-claude/claude-haiku-4-5";

// Random words to avoid Claude memorizing test values across runs
const WORD_A = `alpha${Math.random().toString(36).slice(2, 6)}`;
const WORD_B = `beta${Math.random().toString(36).slice(2, 6)}`;
const WORD_C = `gamma${Math.random().toString(36).slice(2, 6)}`;

// Use harness but with custom args - start on non-provider model
const harness = createRpcHarness({
	name: "session-resume",
	args: ["--model", `${OTHER_PROVIDER}/${OTHER_MODEL}`],
	defaultTimeout: TIMEOUT,
});

const { stop, send, promptAndWait, waitForEvent, DEBUG_LOG } = harness;

function finish(code, msg) {
	if (code !== 0) throw new Error(msg);
	console.log(`test_exit=${code}\n${msg}`);
}

// Start pi
try {
	harness.start();
	await new Promise((r) => setTimeout(r, 2000));
  // Turn 1: Non-provider prompt — establishes context before our provider is used
  console.log("turn=1\nNon-provider prompt (establish context)...");
  const text1 = await promptAndWait(`The secret word is '${WORD_A}'. Acknowledge and be very brief.`);
  if (!text1) finish(1, "FAIL: Turn 1 produced no text");
  console.log(`response=${JSON.stringify(text1.slice(0, 80))}`);

  // Switch to provider — first provider turn with prior history (Case 2)
  const [bridgeProvider, bridgeModelId] = BRIDGE_MODEL.split("/");
  console.log(`model=${BRIDGE_MODEL}`);
  await send({ type: "set_model", provider: bridgeProvider, modelId: bridgeModelId });


  // Turn 2: First provider turn — should see WORD_A from prior non-provider history
  console.log("turn=2\nFirst provider turn with prior history (Case 2)...");
  const text2 = await promptAndWait(
    `The backup word is '${WORD_B}'. Also, what was the secret word? Reply with both words separated by a comma.`
  );
  console.log(`response=${JSON.stringify(text2.slice(0, 80))}`);
  const lower2 = text2.toLowerCase();
  for (const word of [WORD_A, WORD_B]) {
    if (!lower2.includes(word)) finish(1, `missing_word=${word}\nTurn 2: ${text2}`);
  }

  // Switch to other model — creates missed messages
  console.log(`model=${OTHER_PROVIDER}/${OTHER_MODEL}`);
  await send({ type: "set_model", provider: OTHER_PROVIDER, modelId: OTHER_MODEL });

  // Turn 3: Non-provider prompt — adds context that provider must see on switch-back
  console.log("turn=3\nNon-provider prompt (creates missed messages)...");
  const text3 = await promptAndWait(`The third word is '${WORD_C}'. Acknowledge briefly.`);
  if (!text3) finish(1, "FAIL: Turn 3 produced no text");
  console.log(`response=${JSON.stringify(text3.slice(0, 80))}`);

  // Switch back to provider — context includes all prior turns (Case 4)
  console.log(`model=${BRIDGE_MODEL}`);
  await send({ type: "set_model", provider: bridgeProvider, modelId: bridgeModelId });


  // Turn 4: Provider resumes with missed messages (Case 4)
  console.log("turn=4\nProvider resume with missed messages (Case 4)...");
  const text4 = await promptAndWait(
    "What were all three words? Reply with just the three words separated by commas."
  );
  console.log(`response=${JSON.stringify(text4.slice(0, 80))}`);
  const lower4 = text4.toLowerCase();
  for (const word of [WORD_A, WORD_B, WORD_C]) {
    if (!lower4.includes(word)) finish(1, `missing_word=${word}\nTurn 4: ${text4}`);
  }

  // Turn 5: Abort mid-stream — the session must survive and be resumed next turn
  console.log("turn=5\nAbort mid-stream (session recovery)...");
  await send({ type: "prompt", message: "Write a detailed 500-word essay about the history of timekeeping." });
  // Set up idle listener before abort so we don't miss agent_end
  const idle5 = waitForEvent("agent_end");
  await new Promise((r) => setTimeout(r, 2000));
  await send({ type: "abort" });
  await idle5;


  // Turn 6: Provider turn after abort — should NOT get "conversation not found"
  console.log("turn=6\nProvider turn after abort (should recover)...");
  const text6 = await promptAndWait(
    "What were all three words from earlier? Reply with just the three words separated by commas."
  );
  console.log(`response=${JSON.stringify(text6.slice(0, 80))}`);
  const lower6 = text6.toLowerCase();
  for (const word of [WORD_A, WORD_B, WORD_C]) {
    if (!lower6.includes(word)) finish(1, `missing_word=${word}\nTurn 6: ${text6}`);
  }

  // sessionId stability: the id stays stable across normal rebuilds (Case 2 →
  // Case 4 → Case 3) and across the Turn 5 abort: no tool call was in flight,
  // so the bridge waits for the killed child to exit and resumes the same
  // session on Turn 6 (prompt cache warm). A rotation only happens when the
  // child's exit could not be confirmed within the grace.
  const debugLog = readFileSync(DEBUG_LOG, "utf8");
  const sessionIds = new Set();
  const rotated = [];
  for (const match of debugLog.matchAll(/syncResult: path=(reuse|rebuild) sessionId=([a-f0-9-]+)(?: priors=\d+ (\S+))?/g)) {
    sessionIds.add(match[2]);
    if (match[3] === "rotated") rotated.push(match[2]);
  }
  if (sessionIds.size === 0) finish(1, "FAIL: no syncResult markers found in debug log");
  if (sessionIds.size !== 1) finish(1, `FAIL: expected exactly 1 sessionId (the abort must not rotate), got ${sessionIds.size}: ${[...sessionIds].join(", ")}`);
  if (rotated.length !== 0) finish(1, `FAIL: expected no rotation, got ${rotated.length}`);
  if (!debugLog.includes("provider: abort settled cleanly")) finish(1, "FAIL: the Turn 5 abort did not settle cleanly");
  console.log(`session_ids=${sessionIds.size}\nThe abort kept the session.`);

  finish(0, "PASS");
} catch (e) {
  console.error(`test_exit=1\n${e.stack ?? e.message}`);
	process.exitCode = 1;
} finally {
	await stop();
}
