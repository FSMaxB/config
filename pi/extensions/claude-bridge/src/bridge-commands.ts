// The /pi-claude command surface: settings/status UI and the deterministic
// connector-inventory report. Extracted from index.ts (pure move).

import { type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { listAccountConnectors, resolveClaudeOAuth } from "./connector-inventory.js";
import { connectorCredentialEnv, readCredentialFile } from "./connector-runtime.js";

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

// Deterministic connector enumeration for the host app. Reports the
// failure reason rather than an empty list, so "no connectors" and "could not
// check" stay distinguishable.
async function reportConnectorInventory(ctx: {
	ui: ExtensionUIContext;
}): Promise<void> {
	const credentials = resolveClaudeOAuth(readCredentialFile, connectorCredentialEnv());
	if (!credentials) {
		ctx.ui.notify("Pi Claude: no Claude OAuth credentials found — cannot enumerate connectors.", "error");
		return;
	}
	const inventory = await listAccountConnectors({ credentials });
	if (!inventory.ok) {
		ctx.ui.notify(`Pi Claude: connector enumeration failed — ${inventory.reason}`, "error");
		return;
	}
	if (inventory.connectors.length === 0) {
		ctx.ui.notify("Pi Claude: this account has no connectors installed.", "info");
		return;
	}
	const names = inventory.connectors.map((c) => c.name).join(", ");
	ctx.ui.notify(`Pi Claude: ${inventory.connectors.length} connector(s) installed — ${names}`, "info");
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
	pi.registerCommand("pi-claude:connectors", {
		description: "List the Claude account's installed claude.ai connectors",
		handler: async (_args: string, ctx) => reportConnectorInventory(ctx),
	});
}
