// The /pi-claude status command.

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";

const COMMANDS_REGISTERED_KEY = Symbol.for("claude-bridge:commandsRegistered");

function commandCwd(context: unknown): string {
	const value = (context as { cwd?: unknown })?.cwd;
	return typeof value === "string" && value.length > 0 ? value : process.cwd();
}

function showBridgeStatus(context: { ui: ExtensionUIContext; cwd?: string }): void {
	const config = loadConfig(commandCwd(context));
	context.ui.notify([
		`Pi Claude: ${config.enabled === false ? "disabled" : "enabled"}`,
		"Claude account billing settings (including Extra Usage) are managed in Claude.",
	].join("\n"), "info");
}

export function registerBridgeCommands(pi: ExtensionAPI): void {
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[COMMANDS_REGISTERED_KEY]) return;
	guard[COMMANDS_REGISTERED_KEY] = true;

	pi.registerCommand("pi-claude", {
		description: "Show Pi Claude status",
		handler: async (args: string, context) => {
			if (args.trim()) context.ui.notify("Unknown /pi-claude argument.", "warning");
			showBridgeStatus(context);
		},
	});
}
