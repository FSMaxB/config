import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  contextMessages,
  latestMarkerIsActive,
} from "./context-compat.ts";
import {
  loadPolicyConfig,
} from "../subagent/model-policy.ts";
import type {
  SubagentModelConfig,
} from "../subagent/model-policy.ts";
import { ContextChange, requiredContextChange } from "./context-sync.ts";
import { isOffByDefaultModel } from "../lib/model-defaults.ts";
import { sessionIsEmpty } from "../lib/session-empty.ts";
import { isAlwaysOn } from "./settings.ts";
import { errorMessage } from "../lib/errors.ts";
import { onFooterStatusClick } from "../lib/footer-status-click.ts";
import { isRecord } from "../lib/untyped.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = join(
  EXTENSION_DIR,
  "..",
  "..",
  "skills",
  "i-have-adhd",
  "SKILL.md",
);
const STATE_ENTRY_TYPE = "i-have-adhd-state";
const RULES_MESSAGE_TYPE = "i-have-adhd-rules";
const DISABLED_MESSAGE_TYPE = "i-have-adhd-disabled";
const STATUS_KEY = "i-have-adhd";
const DISABLE_CONFIRMATION = "ADHD mode disabled.";
const STOP_PHRASES = new Set(["stop adhd mode", "normal mode"]);
const RULES_HEADER =
  'ADHD MODE ACTIVE. The ruleset below applies to every response until turned off. "stop adhd mode" or "normal mode" turns it off for this session.';
const DISABLED_NOTICE =
  "ADHD MODE OFF. Ignore the i-have-adhd ruleset injected earlier in this conversation and return to your default response style.";

export default function adhdModeExtension(pi: ExtensionAPI): void {
  const rules = loadRules();
  const policyConfig = loadPolicyConfig(join(EXTENSION_DIR, "..", "subagent"));
  let enabled = false;

  const updateStatus = (context: ExtensionContext): void => {
    const { theme } = context.ui;
    // A dim label instead of no status keeps the toggle clickable in the footer.
    if (!enabled) {
      context.ui.setStatus(STATUS_KEY, theme.fg("dim", "○ ADHD off"));
      return;
    }

    const dot = theme.fg("success", "●");
    const label = theme.fg("accent", "ADHD ON");
    context.ui.setStatus(STATUS_KEY, `${dot} ${label}`);
  };

  /**
   * Keep the conversation in sync with the current mode, the way the Claude Code
   * SessionStart hook does: inject the ruleset once, never per request. An empty
   * session is left alone: `before_agent_start` injects with the first prompt, so
   * the model selected until then still decides the default.
   */
  const requiredChange = (context: ExtensionContext): ContextChange =>
    requiredContextChange(enabled ? "enabled" : "disabled", rulesAreInContext(context) ? "in-context" : "missing");

  const syncContext = (context: ExtensionContext): void => {
    if (isEmpty(context)) return;

    const message = contextMessage(requiredChange(context), rules);
    if (message === undefined) return;

    pi.sendMessage(message, { triggerTurn: false });
  };

  const restoreState = (context: ExtensionContext): void => {
    enabled = resolveEnabled(pi, policyConfig, context, context.model);
    updateStatus(context);
    syncContext(context);
  };

  const followModel = (
    context: ExtensionContext,
    model: ExtensionContext["model"],
  ): void => {
    if (!isEmpty(context)) return;

    enabled = resolveEnabled(pi, policyConfig, context, model);
    updateStatus(context);
  };

  const setEnabled = (next: "enabled" | "disabled", context: ExtensionContext): void => {
    enabled = next === "enabled";
    pi.appendEntry(STATE_ENTRY_TYPE, { enabled } satisfies AdhdModeState);
    updateStatus(context);
    syncContext(context);
    context.ui.notify(`ADHD mode ${enabled ? "enabled" : "disabled"}`, "info");
  };

  onFooterStatusClick(pi.events, STATUS_KEY, async (context) => {
    setEnabled(enabled ? "disabled" : "enabled", context);
  });

  pi.registerFlag("adhd", {
    description: "Start with ADHD-friendly output enabled",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("i-have-adhd", {
    description: "Toggle ADHD-friendly output for this session",
    handler: async (commandArguments, context) => {
      const argument = commandArguments.trim().toLowerCase();

      if (argument === "") {
        setEnabled(enabled ? "disabled" : "enabled", context);
        return;
      }

      if (argument === "on") {
        setEnabled("enabled", context);
        return;
      }

      if (argument === "off" || argument === "stop") {
        setEnabled("disabled", context);
        return;
      }

      context.ui.notify("Usage: /i-have-adhd [on|off]", "warning");
    },
  });

  pi.on("input", async (event, context) => {
    const input = event.text.trim().toLowerCase();

    // Keep the built-in skill command working as an alias without letting Pi
    // expand a second copy of the same rules into the conversation.
    if (input === "/skill:i-have-adhd") {
      setEnabled("enabled", context);
      return { action: "handled" };
    }

    if (enabled && STOP_PHRASES.has(input)) {
      setEnabled("disabled", context);

      if (context.hasUI) {
        return { action: "handled" };
      }

      return {
        action: "transform",
        text: `Reply with exactly: ${DISABLE_CONFIRMATION}`,
      };
    }

    return { action: "continue" };
  });

  pi.on("session_start", async (_event, context) => restoreState(context));
  pi.on("session_tree", async (_event, context) => restoreState(context));
  pi.on("session_compact", async (_event, context) => syncContext(context));
  pi.on("model_select", async (event, context) => followModel(context, event.model));
  pi.on("before_agent_start", async (_event, context) => {
    followModel(context, context.model);

    const message = contextMessage(requiredChange(context), rules);
    if (message === undefined) return;

    // Returning the message would put it after the user prompt; the pending
    // queue is flushed before the prompt is appended.
    pi.sendMessage(message, { triggerTurn: false });
  });
}

interface AdhdModeState {
  enabled: boolean;
}

function loadRules(): string {
  let content: string;

  try {
    content = readFileSync(SKILL_PATH, "utf8");
  } catch (error) {
    const reason = errorMessage(error);
    throw new Error(
      `Unable to load i-have-adhd rules from ${SKILL_PATH}: ${reason}`,
      { cause: error },
    );
  }

  const rules = stripFrontmatter(content);
  if (!rules) {
    throw new Error(`The i-have-adhd rules file is empty: ${SKILL_PATH}`);
  }

  return rules;
}

function stripFrontmatter(content: string): string {
  return content
    .replace(
      /^---[^\S\r\n]*\r?\n[\s\S]*?\r?\n---[^\S\r\n]*(?:\r?\n|$)/,
      "",
    )
    .trim();
}

/**
 * Whether the rules are still live in the context the model actually receives.
 *
 * Only the newest marker counts: a later "disabled" notice cancels an earlier
 * ruleset, and compaction drops summarized entries so the ruleset has to be
 * injected again.
 */
function rulesAreInContext(context: ExtensionContext): boolean {
  return latestMarkerIsActive(
    contextMessages(context.sessionManager),
    RULES_MESSAGE_TYPE,
    DISABLED_MESSAGE_TYPE,
  );
}

function isEmpty(context: ExtensionContext): boolean {
  return sessionIsEmpty(context.sessionManager.getBranch());
}

function resolveEnabled(
  pi: ExtensionAPI,
  policyConfig: SubagentModelConfig,
  context: ExtensionContext,
  model: ExtensionContext["model"],
): boolean {
  return (
    getSavedState(context) ??
    (pi.getFlag("adhd") === true ||
      (isAlwaysOn(pi.getSettings()) &&
        !isOffByDefaultModel(model, policyConfig)))
  );
}

function getSavedState(context: ExtensionContext): boolean | undefined {
  let savedState: boolean | undefined;

  for (const entry of context.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) {
      continue;
    }

    if (isRecord(entry.data) && typeof entry.data.enabled === "boolean") {
      savedState = entry.data.enabled;
    }
  }

  return savedState;
}

function contextMessage(change: ContextChange, rules: string): ContextMessage | undefined {
  switch (change) {
    case ContextChange.InjectRules:
      return {
        customType: RULES_MESSAGE_TYPE,
        content: `${RULES_HEADER}\n\n${rules}`,
        display: false,
      };
    case ContextChange.DisableRules:
      return {
        customType: DISABLED_MESSAGE_TYPE,
        content: DISABLED_NOTICE,
        display: false,
      };
    case ContextChange.None:
      return undefined;
  }
}

interface ContextMessage {
  customType: string;
  content: string;
  display: boolean;
}
