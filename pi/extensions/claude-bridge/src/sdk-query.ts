// Shared SDK query factory + its test seam. In its own module so both
// the provider entry (index.ts) and the account host spawn children through
// the same seam — tests swap the factory once and every spawn path honors it.

import { createRequire } from "node:module";
import type * as ClaudeAgentSdkModule from "@anthropic-ai/claude-agent-sdk";
import type { query } from "@anthropic-ai/claude-agent-sdk";

export type SdkQueryFactory = typeof query;
type ClaudeAgentSdk = typeof ClaudeAgentSdkModule;

// Synchronous require() of the ESM SDK keeps the provider's query setup free of awaits;
// loading it at module level cost every pi startup ~50 ms before any query ran.
const requirePackage = createRequire(import.meta.url);
let loadedSdk: ClaudeAgentSdk | undefined;
let testFactory: SdkQueryFactory | undefined;

export function sdkQueryFactory(...args: Parameters<SdkQueryFactory>): ReturnType<SdkQueryFactory> {
	return (testFactory ?? claudeAgentSdk().query)(...args);
}

export function claudeAgentSdk(): ClaudeAgentSdk {
	// require() returns the module untyped; its type is the package's own declaration.
	loadedSdk ??= requirePackage("@anthropic-ai/claude-agent-sdk") as ClaudeAgentSdk;
	return loadedSdk;
}

/** Test seam for exercising the real bridge retry/session orchestration without
 *  spending Claude usage. Production never calls this. */
export function __testSetSdkQueryFactory(factory?: SdkQueryFactory): void {
	testFactory = factory;
}
