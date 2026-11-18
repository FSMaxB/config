import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { sanitizeDisplayText } from "./lib/format.ts";
import { registerToolWithGuidelines } from "./lib/register-tool.ts";

// Fits a terminal title and the session selector without truncation.
const MAX_LENGTH = 80;

// The sanitized name, or no name when nothing survived sanitization.
type SessionNameDetails = { requested: string; kind: "set"; name: string } | { requested: string; kind: "empty" };

export default function (pi: ExtensionAPI): void {
  registerToolWithGuidelines(pi, {
    name: "set_session_name",
    label: "Set session name",
    description:
      "Set the session name: a short description of what this session is about. " +
      "It is shown in the session selector, the terminal title, and notifications. " +
      `Only letters, digits, whitespace and ,.!? survive sanitization; at most ${MAX_LENGTH} characters.`,
    promptSnippet:
      "Set the session name to a short description of what the session is about",
    promptGuidelines: [
      "Set the session name with set_session_name as soon as the topic of the session is clear, and update it when the focus shifts.",
    ],
    parameters: Type.Object({
      name: Type.String({
        description: "Short description of what this session is about",
      }),
    }),

    async execute(_toolCallId, params): Promise<AgentToolResult<SessionNameDetails>> {
      const name = sanitizeDisplayText(params.name, MAX_LENGTH);
      if (!name) {
        const error =
          "Session name is empty after sanitization (allowed characters: letters, digits, whitespace and ,.!?). Call set_session_name again with usable text.";
        return {
          content: [{ type: "text", text: error }],
          details: { requested: params.name, kind: "empty" },
        };
      }

      pi.setSessionName(name);
      return {
        content: [{ type: "text", text: `Session name set: ${name}` }],
        details: { requested: params.name, kind: "set", name },
      };
    },

    renderCall(args, theme) {
      const requested = typeof args.name === "string" ? args.name : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("set_session_name ")) +
          theme.fg("muted", requested),
        0,
        0,
      );
    },

    renderResult(result, _renderOptions, theme) {
      const { details } = result;
      // Checks the name rather than the kind, so results stored without a kind render too.
      const name = details !== undefined && "name" in details ? details.name : undefined;
      if (!name) {
        return new Text(
          theme.fg("error", "✗ Name empty after sanitization"),
          0,
          0,
        );
      }
      return new Text(
        theme.fg("success", "✓ ") + theme.fg("accent", name),
        0,
        0,
      );
    },
  });
}
