// RTK Pi extension — rewrites bash commands to use rtk for token savings.
// Requires: rtk >= 0.23.0 in PATH.
//
// This is a thin delegating extension: all rewrite logic lives in `rtk rewrite`,
// which is the single source of truth (src/discover/registry.rs).
// To add or change rewrite rules, edit the Rust registry — not this file.
//
// Exit code contract for `rtk rewrite`:
//   0 + stdout  Rewrite found → mutate command
//   1           No RTK equivalent → pass through unchanged
//   3 + stdout  Rewrite (advisory) → mutate command

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BashToolCallEvent,
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { sessionIsEmpty } from "../lib/session-empty.ts";
import { loadPolicyConfig } from "../subagent/model-policy.ts";
import {
  commandMode,
  flagMode,
  resolveMode,
  RtkMode,
  type RtkState,
  savedMode,
  STATE_ENTRY_TYPE,
} from "./mode.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const STATUS_KEY = "rtk";
const REWRITE_TIMEOUT_MS = 2_000;
const MIN_SUPPORTED_RTK_MINOR = 23;

export default async function (pi: ExtensionAPI) {
  // Registered before probing the binary: pi rejects unknown CLI flags, so they have to exist even when rtk is missing.
  pi.registerFlag("rtk", {
    description: "Start with bash commands rewritten through rtk",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("no-rtk", {
    description: "Start without rewriting bash commands through rtk",
    type: "boolean",
    default: false,
  });

  const policyConfig = loadPolicyConfig(join(EXTENSION_DIR, "..", "subagent"));
  const usable = await rtkIsUsable(pi);
  let mode: RtkMode = RtkMode.Off;

  const rewritesCommands = (): boolean =>
    usable && mode === RtkMode.On && process.env.RTK_DISABLED !== "1";

  const updateStatus = (context: ExtensionContext): void => {
    if (!rewritesCommands()) {
      context.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const dot = context.ui.theme.fg("success", "●");
    const label = context.ui.theme.fg("accent", "RTK ON");
    context.ui.setStatus(STATUS_KEY, `${dot} ${label}`);
  };

  const restoreState = (context: ExtensionContext, model: ExtensionContext["model"]): void => {
    mode = resolveMode({
      saved: savedMode(context.sessionManager.getBranch()),
      flag: flagMode(pi.getFlag("rtk"), pi.getFlag("no-rtk")),
      settings: pi.getSettings(),
      model,
      policyConfig,
    });
    updateStatus(context);
  };

  // Same rule as i-have-adhd: once the session has messages, the mode no longer follows the model.
  const followModel = (context: ExtensionContext, model: ExtensionContext["model"]): void => {
    if (!sessionIsEmpty(context.sessionManager.getBranch())) return;
    restoreState(context, model);
  };

  const setMode = (nextMode: RtkMode, context: ExtensionContext): void => {
    mode = nextMode;
    pi.appendEntry(STATE_ENTRY_TYPE, { mode } satisfies RtkState);
    updateStatus(context);
    context.ui.notify(`rtk ${mode === RtkMode.On ? "enabled" : "disabled"}`, "info");
    if (mode === RtkMode.Off) return;
    if (!usable) {
      context.ui.notify("rtk binary missing or older than 0.23.0, commands are not rewritten", "warning");
    }
    if (process.env.RTK_DISABLED === "1") {
      context.ui.notify("RTK_DISABLED=1 is set, commands are not rewritten", "warning");
    }
  };

  pi.registerCommand("rtk", {
    description: "Toggle rewriting bash commands through rtk for this session",
    handler: async (args, context) => {
      const nextMode = commandMode(args, mode);
      if (nextMode === undefined) {
        context.ui.notify("Usage: /rtk [on|off]", "warning");
        return;
      }
      setMode(nextMode, context);
    },
  });

  pi.on("session_start", async (_event, context) => restoreState(context, context.model));
  pi.on("session_tree", async (_event, context) => restoreState(context, context.model));
  pi.on("model_select", async (event, context) => followModel(context, event.model));
  pi.on("before_agent_start", async (_event, context) => followModel(context, context.model));

  pi.on("tool_call", async (event, context) => {
    try {
      if (!isBashToolCallEvent(event)) return;
      if (!rewritesCommands()) return;

      const command = event.input.command;
      if (typeof command !== "string" || command.trim() === "") return;

      if (command.startsWith("rtk ")) return;

      // Delegate to RTK.
      const rewritten = await rewriteCommand(pi, command, context.signal);
      if (!rewritten || rewritten === command) return;
      // `rtk read` is byte-identical to cat, and its --max-lines mode (what `head -N` becomes)
      // collapses function bodies to `{ }` skeletons, so the model would see code that is not there.
      if (rewritten.includes("rtk read ")) return;
      event.input.command = rewritten;
    } catch (error) {
      // Fail open: never block execution on an unexpected error.
      console.warn("[rtk] unexpected error in tool_call handler; passing through command", error);
      return;
    }
  });
}

// Probes rtk once at load; rewriting stays off if it is missing or predates `rtk rewrite` (0.23.0).
async function rtkIsUsable(pi: ExtensionAPI): Promise<boolean> {
  const version = await pi.exec("rtk", ["--version"], { timeout: REWRITE_TIMEOUT_MS });
  if (version.code !== 0) {
    console.warn("[rtk] rtk binary not found in PATH — rewriting disabled");
    return false;
  }
  const parsed = parseSemver(version.stdout.replace(/^rtk\s+/, ""));
  if (!parsed) return true;
  const [major, minor] = parsed;
  if (major === 0 && minor < MIN_SUPPORTED_RTK_MINOR) {
    console.warn(`[rtk] rtk ${version.stdout.trim()} is too old (need >= 0.23.0) — rewriting disabled`);
    return false;
  }
  return true;
}

// Parse "X.Y.Z" semver, return [major, minor, patch] or null.
function parseSemver(raw: string): [number, number, number] | null {
  const match = raw.trim().match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
}

// Local reimplementation of the package's `isToolCallEventType("bash", event)` type
// guard. That helper is a value export, so importing it pulls in the whole
// `@earendil-works/pi-coding-agent` barrel at extension load — profiled at ~250ms
// warmed, vs ~10ms for a type-only import. `BashToolCallEvent`/`ToolCallEvent`
// below are type-only imports and are erased at compile time, so they carry none
// of that cost. See #2753.
function isBashToolCallEvent(event: ToolCallEvent): event is BashToolCallEvent {
  return event.toolName === "bash";
}

// Calls `rtk rewrite`; returns the rewritten command or null (pass through).
async function rewriteCommand(
  pi: ExtensionAPI,
  command: string,
  signal?: AbortSignal
): Promise<string | null> {
  const result = await pi.exec("rtk", ["rewrite", command], {
    timeout: REWRITE_TIMEOUT_MS,
    signal,
  });
  if (result.killed) return null;
  if (result.code !== 0 && result.code !== 3) return null;
  return result.stdout.trim() || null;
}
