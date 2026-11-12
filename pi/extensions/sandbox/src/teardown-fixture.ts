import { SandboxManager } from "@anthropic-ai/sandbox-runtime";

// Run by integration.test.ts in its own process: whether this process exits on its own after
// initialize() shows whether srt still holds handles open.
const teardown = process.argv[2];
if (teardown !== "reset" && teardown !== "keep") throw new Error(`Unknown teardown: ${teardown}`);

await SandboxManager.initialize(
  { network: { allowedDomains: [], deniedDomains: [] }, filesystem: { denyRead: [], allowWrite: [], denyWrite: [] }, allowPty: false },
  async () => false,
  true,
);
if (teardown === "reset") await SandboxManager.reset();
