import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const MAX_LENGTH = 80;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "set_session_name",
    label: "Set session name",
    description:
      "Set the session name: a short description of what this session is about. " +
      "It is shown in the session selector, the terminal title, and notifications. " +
      "Set it as soon as the topic of the session is clear, and update it when the focus shifts. " +
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

    async execute(_toolCallId, params) {
      const name = sanitize(params.name);
      const details: { requested: string; name: string | null } = {
        requested: params.name,
        name: name || null,
      };

      if (!name) {
        const error =
          "Session name is empty after sanitization (allowed characters: letters, digits, whitespace and ,.!?). Call set_session_name again with usable text.";
        return {
          content: [{ type: "text", text: error }],
          isError: true,
          details,
        };
      }

      pi.setSessionName(name);
      return {
        content: [{ type: "text", text: `Session name set: ${name}` }],
        details,
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
      const details = result.details as
        | { requested: string; name: string | null }
        | undefined;
      if (!details?.name) {
        return new Text(
          theme.fg("error", "✗ Name empty after sanitization"),
          0,
          0,
        );
      }
      return new Text(
        theme.fg("success", "✓ ") + theme.fg("accent", details.name),
        0,
        0,
      );
    },
  });
}

function sanitize(raw: string): string {
  return raw
    .replace(/[^\p{L}\p{N}\s.,!?]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LENGTH)
    .trim();
}
