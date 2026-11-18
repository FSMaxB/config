// The /pi-claude status command.

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";

const COMMANDS_REGISTERED_KEY = Symbol.for("claude-bridge:commandsRegistered");

export function registerBridgeCommands(pi: ExtensionAPI): void {
	// A mark on the pi object itself, so a second copy of the extension does not register the command twice.
	if (Reflect.get(pi, COMMANDS_REGISTERED_KEY)) return;
	Reflect.set(pi, COMMANDS_REGISTERED_KEY, true);

	pi.registerCommand("pi-claude", {
		description: "Show Pi Claude status",
		handler: async (commandArguments: string, context) => {
			if (commandArguments.trim()) context.ui.notify("Unknown /pi-claude argument.", "warning");
			showBridgeStatus(context);
		},
	});
}

function showBridgeStatus(context: { ui: ExtensionUIContext; cwd?: string }): void {
	const config = loadConfig(commandCwd(context));
	context.ui.notify([
		`Pi Claude: ${config.enabled === false ? "disabled" : "enabled"}`,
		"Claude account billing settings (including Extra Usage) are managed in Claude.",
	].join("\n"), "info");
}

function commandCwd(context: { cwd?: unknown }): string {
	const value = context.cwd;
	return typeof value === "string" && value.length > 0 ? value : process.cwd();
}
