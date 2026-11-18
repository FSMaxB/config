// Native pi >=0.86 provider construction.
//
// The provider is ALWAYS registered, and `auth.apiKey.check/resolve` report
// configured-ness from existence-only credential probes, so pi itself hides
// claude-bridge models while no Claude credentials are present and shows them
// when they appear. A plain config with the dummy `apiKey: "not-used"` would
// count as configured, and every request would fail at spawn.
//
// Still needed alongside it (see DEVELOPMENT.md "Provider registration"): the process-global primary-instance/stream-guard tokens stay
// (pi's registerNativeProvider is replace-by-id, so an unguarded subagent
// re-registration would still swap in its own streamSimple), and the pre-spawn
// credential fail-fast in streamSimple stays (a mid-session logout must fail
// the turn with an actionable message even if the picker snapshot is stale).
//
// SECURITY: like auth-presence.ts, this module only reports credential
// EXISTENCE. resolve() hands pi a dummy key —
// the Claude Code subprocess does its own authentication; pi never needs a
// real secret, so none is read or exposed.

import type * as PiAi from "@earendil-works/pi-ai";
import type { Api, Provider, SimpleStreamOptions, StreamFunction } from "@earendil-works/pi-ai";
import { hasClaudeCredentials } from "./auth-presence.js";
import type { BridgeModel } from "./models.js";
import { PROVIDER_ID } from "./convert.js";

export const NATIVE_PROVIDER_UNSUPPORTED_MESSAGE =
	"Claude bridge requires pi >= 0.86 (native provider API with transcript contexts). Upgrade the host pi.";

/** pi-ai gained createProvider in 0.81 with the object-form registerProvider,
 *  and getCurrentTools in 0.86 when providers started receiving a
 *  TranscriptContext. The bridge reads its tool set from the transcript, so an
 *  older host would register fine and then offer Claude Code no tools at all;
 *  refuse it up front instead. */
export function supportsNativeProvider(piAi: unknown): boolean {
	if (typeof piAi !== "object" || piAi === null) return false;
	return typeof Reflect.get(piAi, "createProvider") === "function" && typeof Reflect.get(piAi, "getCurrentTools") === "function";
}

/** Auth source label for pi's status UI, chosen by the same existence-only
 *  probes hasClaudeCredentials uses. Never reads credential contents. */
export function claudeAuthSourceLabel(environment: NodeJS.ProcessEnv = process.env): string {
	if (environment.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return "CLAUDE_CODE_OAUTH_TOKEN";
	if (environment.ANTHROPIC_API_KEY?.trim()) return "ANTHROPIC_API_KEY";
	if (environment.ANTHROPIC_AUTH_TOKEN?.trim()) return "ANTHROPIC_AUTH_TOKEN";
	return "Claude Code login";
}

/**
 * Build the Provider object for pi.registerProvider(provider).
 *
 * `piAi` is the HOST's pi-ai namespace (the bundle externalizes it), passed in
 * rather than imported so a pre-0.86 host fails the supportsNativeProvider()
 * check with a clear message instead of crashing module load on a missing
 * named export. `env` is bindable for tests; the credential probes themselves
 * run at check/resolve CALL time, so a login/logout between calls is seen.
 */
export function buildNativeProvider(
	piAi: Pick<typeof PiAi, "createProvider">,
	models: readonly BridgeModel[],
	streamSimple: StreamFunction<Api, SimpleStreamOptions>,
	environment: NodeJS.ProcessEnv = process.env,
	// Availability probe, evaluated at check/resolve time.
	hasCredentials: () => boolean = () => hasClaudeCredentials(environment),
): Provider {
	if (!supportsNativeProvider(piAi)) {
		throw Object.assign(new Error(NATIVE_PROVIDER_UNSUPPORTED_MESSAGE), { code: "CLAUDE_BRIDGE_NATIVE_PROVIDER_UNSUPPORTED" });
	}
	// The legacy config path stamped provider/api/baseUrl onto each model during
	// composition; createProvider passes models through verbatim, so stamp here.
	// Stamps win over any provider field the source model carries — the models
	// come from pi-ai's anthropic registry and must be re-homed under pi-claude.
	const stamped = models.map((model) => ({ ...model, api: "claude-bridge", baseUrl: "claude-bridge", provider: PROVIDER_ID }));
	// The Claude Code subprocess router IS the implementation for both stream
	// entry points — there is no raw-API shape to dispatch to.
	const streams = {
		stream: streamSimple,
		streamSimple,
	};
	return piAi.createProvider({
		id: PROVIDER_ID,
		name: "Pi Claude",
		baseUrl: "claude-bridge",
		auth: {
			apiKey: {
				name: "Claude Code credentials",
				// check() exists so pi's availability pass never has to call
				// resolve(): both are existence-only, but check is the documented
				// side-effect-free probe.
				check: async () => (hasCredentials() ? { type: "api_key" as const, source: claudeAuthSourceLabel(environment) } : undefined),
				resolve: async () => (hasCredentials()
					? { auth: { apiKey: "not-used" }, source: claudeAuthSourceLabel(environment) }
					: undefined),
			},
		},
		models: stamped,
		api: streams,
	});
}
