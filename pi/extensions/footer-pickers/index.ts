import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { whileAttended } from "../lib/attended-prompts.ts";
import { settledAvailableModels } from "../lib/available-models.ts";
import { modelLabel } from "../lib/default-model.ts";
import { errorMessage } from "../lib/errors.ts";
import { clickStatus } from "../lib/footer-status-click.ts";
import { preferredThinkingLevel, thinkingLevelLabel } from "../lib/plan-mode-policy.ts";
import { searchWithDefault } from "../lib/search-select.ts";
import { selectWithDefault } from "../lib/select-with-default.ts";
import { serialize } from "../lib/ui-queue.ts";
import { installFooterClickHandler } from "./footer-hook.ts";
import type { ClickOutcome, FooterView } from "./footer-hook.ts";
import { footerTargetAt, thinkingDisplay } from "./regions.ts";
import type { FooterSnapshot, FooterTarget, ModelDisplay, TextMeasure } from "./regions.ts";

const measure: TextMeasure = { width: visibleWidth, strip: stripTerminalSequences };

export default function footerPickersExtension(pi: ExtensionAPI): void {
  // State lives in this closure, not at module level: pi re-runs the factory for new sessions.
  let session: ExtensionContext | undefined;
  let picker: PickerState = "closed";

  pi.on("session_start", async (_event, context) => {
    session = context;
    if (context.mode !== "tui") return;
    if (installFooterClickHandler(handleClick) === "conflict") {
      context.ui.notify("pi's footer handles mouse clicks itself now; footer pickers are disabled.", "warning");
    }
  });

  pi.on("session_shutdown", async () => {
    session = undefined;
  });

  function handleClick(view: FooterView, column: number, row: number): ClickOutcome {
    const context = session;
    if (!context) return "ignored";

    const snapshot: FooterSnapshot = { ...view, model: modelDisplay(context.model, pi.getThinkingLevel()) };
    const target = footerTargetAt(snapshot, column, row, measure);
    if (!target) return "ignored";
    // A second click while a picker is open must not stack another one.
    if (picker === "open") return "handled";

    picker = "open";
    void serialize(() => whileAttended(pi.events, () => actOn(target, context)))
      .catch((error: unknown) => {
        context.ui.notify(`Footer click failed: ${errorMessage(error)}`, "error");
      })
      .finally(() => {
        picker = "closed";
      });
    return "handled";
  }

  async function actOn(target: FooterTarget, context: ExtensionContext): Promise<void> {
    switch (target.kind) {
      case "model":
        await pickModel(context);
        return;
      case "thinking":
        await pickThinkingLevel(context);
        return;
      case "status":
        await clickStatus(pi.events, target.key, context);
        return;
    }
  }

  async function pickModel(context: ExtensionContext): Promise<void> {
    const models = await settledAvailableModels(context);
    if (models.length === 0) {
      context.ui.notify("No models with configured auth are available.", "warning");
      return;
    }

    const current = context.model ? modelLabel(context.model) : undefined;
    const isCurrent = (model: Model<Api>): boolean => modelLabel(model) === current;
    const ordered = [...models.filter(isCurrent), ...models.filter((model) => !isCurrent(model))];
    const labels = ordered.map((model) => (isCurrent(model) ? `${modelLabel(model)} (current)` : modelLabel(model)));
    // The current model comes first, so the list opens on it.
    const choice = await searchWithDefault(context.ui, "Model", labels, labels[0], "question");
    if (choice === undefined) return;

    const model = ordered[labels.indexOf(choice)];
    if (!(await pi.setModel(model))) {
      context.ui.notify(`No auth configured for ${modelLabel(model)}.`, "error");
    }
  }

  async function pickThinkingLevel(context: ExtensionContext): Promise<void> {
    const { model } = context;
    if (!model) return;

    const levels = getSupportedThinkingLevels(model);
    if (levels.length <= 1) {
      context.ui.notify(`${modelLabel(model)} has no thinking levels.`, "info");
      return;
    }

    const defaultLevel = clampThinkingLevel(model, preferredThinkingLevel(modelLabel(model), pi.getSettings()));
    const current = pi.getThinkingLevel();
    const options = levels.map((level) => thinkingLevelLabel(level, defaultLevel, current));
    const choice = await selectWithDefault(
      context.ui,
      "Thinking level",
      options,
      options[levels.indexOf(current)] ?? options[0],
      "question",
    );
    if (choice === undefined) return;

    pi.setThinkingLevel(levels[options.indexOf(choice)]);
  }
}

type PickerState = "open" | "closed";

function modelDisplay(model: Model<Api> | undefined, level: string): ModelDisplay | undefined {
  if (!model) return undefined;
  return { provider: model.provider, id: model.id, thinking: model.reasoning ? thinkingDisplay(level) : undefined };
}
