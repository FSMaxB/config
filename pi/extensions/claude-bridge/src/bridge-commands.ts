// The /pi-claude status command.

import { type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";

const COMMANDS_REGISTERED_KEY = Symbol.for("claude-bridge:commandsRegistered");

function commandCwd(ctx: unknown): string {
	const value = (ctx as { cwd?: unknown })?.cwd;
	return typeof value === "string" && value.length > 0 ? value : process.cwd();
}

function showBridgeStatus(ctx: { ui: ExtensionUIContext; cwd?: string }): void {
	const config = loadConfig(commandCwd(ctx));
	ctx.ui.notify([
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
		handler: async (args: string, ctx) => {
			if (args.trim()) ctx.ui.notify("Unknown /pi-claude argument.", "warning");
			showBridgeStatus(ctx);
		},
	});
}
