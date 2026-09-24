# pi-claude-bridge (fork)

A Pi provider that uses a logged-in Claude Code account through the Claude Agent SDK. You keep Pi's terminal interface and tools while Claude Code handles model requests.

## About this fork

This directory is a fork of [`@vanillagreen/pi-claude-bridge`](https://github.com/vanillagreencom/kendex/tree/main/pi-extensions/pi-claude-bridge) 4.0.2 by Eli Dickinson (vanillagreen), published under the MIT license. The upstream copyright notice and license text are kept in [LICENSE](LICENSE); modifications made here are copyright Max Bruckner and released under the same license. The first commit touching this directory is the unmodified upstream import, so `jj diff` from that commit shows every local change.

Differences from upstream:

- Pi loads the extension from source: outer `index.ts` forwards the default extension factory from `src/index.ts`; named APIs live in `src/index.ts`. There is no `bundle/` build step or `esbuild`.
- Dependencies come from this directory's own `package.json`; `@modelcontextprotocol/sdk` is declared explicitly because the bundle no longer inlines it.
- Pi tools are served to Claude Code through a low-level MCP server (`src/tool-server.ts`) that forwards their JSON Schema unchanged, instead of the upstream TypeBox-to-Zod conversion, which dropped `integer`, min/max bounds and other keywords.
- The provider reads Pi 0.86+ transcripts: the system prompt and tool set come from the transcript's system messages through pi-ai's replay helpers, and the bridge's cursors count conversation messages only. Pi 0.86 or later is required.
- Configuration uses only nested `claude-bridge.json` files. The extension manager, account router and cloud connector integrations are removed. SDK tools are restricted to Pi's bridge.

## Install

The extension lives in `~/config/pi/extensions/claude-bridge/`, which `install.sh` symlinks into `~/.pi/agent/extensions/`. Run `npm ci` in this directory once so `node_modules/` exists (`install.sh` does this when it is missing), then restart Pi. A Claude Code login is required. Make `claude` available on `PATH` or set its executable path below.

`npm test` runs offline unit tests and `npm run typecheck` runs `tsc`. `npm run test:int` is separate; it needs a logged-in Claude account and the `pi` binary on `PATH`. Restart Pi after changing extension files.

Fable 5.1 requires [Claude Code 2.1.255 or later](https://code.claude.com/docs/en/model-config#work-with-fable). This includes any executable chosen through `pathToClaudeCodeExecutable` or found on `PATH`, which takes precedence over the SDK's bundled CLI. Account access and usage-credit requirements still apply.

## Features

- Select Claude models from Pi's model menu.
- Run Pi tool calls during Claude conversations.
- Resume the Claude conversation across Pi turns.
- Configure model effort and forwarded prompt context.

## How it works

- You pick one of the `pi-claude` models in Pi's model menu; **Claude Fable 5.1** is `pi-claude/claude-fable-5-1`.
- The bridge starts Claude Code, or resumes it, through the Claude Agent SDK, Anthropic's library for driving Claude Code from another program.
- It sends your prompt to Claude Code and offers it only Pi's tools, through the bridge MCP server. Claude Code built-ins, cloud connectors and other MCP servers cannot execute through this provider.
- When Claude Code calls a tool, Pi runs the tool and sends the result back to Claude Code.
- Pi shows the reply and remembers which Claude Code conversation it belongs to, so your next message continues it.

## Settings

Write nested JSON to `<piUserDir>/claude-bridge.json` (normally `~/.pi/agent/claude-bridge.json`; `PI_CODING_AGENT_DIR` changes the directory). A trusted project's `.pi/claude-bridge.json` overrides the user file. Project trust must explicitly report `true`; otherwise the project file is ignored. Starting Pi in a nested project directory still finds its project root. With `CLAUDE_BRIDGE_ISOLATED=1`, only the user file is read. Built-in defaults apply when neither file sets a value.

```json
{
  "enabled": true,
  "provider": {
    "appendSystemPrompt": true,
    "fastMode": false,
    "forceEffort": "high",
    "modelEffortOverrides": { "claude-opus-4-8": "max" },
    "pathToClaudeCodeExecutable": "/path/to/claude"
  },
  "promptContext": { "includeAppendSystemPromptMd": true }
}
```

All fields are optional. `enabled: false` hides the provider after a Pi restart. `appendSystemPrompt` defaults to true and forwards AGENTS and skills; `includeAppendSystemPromptMd` opts into forwarding global and project `.pi/APPEND_SYSTEM.md` with XML escaping. `forceEffort` and `modelEffortOverrides` accept `low`, `medium`, `high`, `xhigh` or `max`; override keys may be bare model ids, `pi-claude/<id>` or `*`, and a per-model entry wins. The executable override is optional; normal executable discovery still applies.

When `appendSystemPrompt` is true, the SDK reads no filesystem setting sources even if `settingSources` is configured. When false, it uses the configured list or defaults to `["user", "project"]`. MCP discovery remains blocked by mandatory strict MCP configuration; only the Pi bridge server can be registered. Filesystem settings may still affect other Claude Code settings, including environment values, so select `project` or `local` only for trusted directories.

**Manual migration:** move surviving flat options from `kendex.extensionManager.config["@vanillagreen/pi-claude-bridge"]` in user/project `settings.json` or from top-level `claude-bridge.json` keys into the nested `provider` or `promptContext` objects above; move `enabled` to the JSON root. The bridge no longer reads manager settings or flat bridge keys. Remove obsolete `strictMcpConfig`, `enableConnectors`, `connectorWriteMode`, `includeProjectAgentsHook`, `includeTaskPanelHook` and `includeCavemanHook`: they have no effect. Do not rely on the old settings panel for this extension. `/pi-claude` displays status and a billing-settings notice; `/pi-claude:connectors` no longer exists. The bridge never rewrites old configuration files.

Environment variables:

- `CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT`: how long a turn may stay silent before its first output; bare numbers are seconds, `ms`, `s` and `m` suffixes are accepted, `0` disables.
- `CLAUDE_BRIDGE_DEBUG=1`: write the bridge log, the integrity diagnostics and per-query Claude Code CLI logs under the Pi agent directory; `CLAUDE_BRIDGE_DEBUG_PATH` and `CLAUDE_BRIDGE_DIAG_PATH` move the two log files. Nothing is written to disk without it.
- `CLAUDE_BRIDGE_ISOLATED=1`: for embedding hosts that own every config directory; the bridge then reads nothing from the working directory or home. Details in [DEVELOPMENT.md](DEVELOPMENT.md).

Tool-result integrity problems always surface as a Pi error notification plus a metadata-only `claude-bridge-integrity` entry in the Pi session file, so a lost tool result can be analysed from the session alone.

Maintainer notes, embedding behavior and test commands are in [DEVELOPMENT.md](DEVELOPMENT.md).

## Prompt context

The bridge sends the nearest AGENTS context file and Pi's skills list with the prompt. It checks `AGENTS.override.md`, `AGENTS.md` and `AGENTS.MD` while walking up from the working directory. Claude Code loads its own CLAUDE.md files. Optional `APPEND_SYSTEM.md` is the only additional forwarded prompt source.

## Session and tool boundaries

The bridge uses the process's ordinary Claude login and `CLAUDE_CONFIG_DIR`. A companion account router cannot supply credentials, select a model or rotate profiles. Ordinary unscoped Pi session markers can resume; old markers with `accountProfileId` are rejected and the Claude session is rebuilt from Pi history without deleting old account files.

Every query, including deferred-input continuations, uses `tools: []`, the Pi MCP permission allowlist, the built-in denylist, strict MCP configuration, only the Pi MCP server and a fail-closed `PreToolUse` hook. `ENABLE_CLAUDEAI_MCP_SERVERS` is forced to `0`. Neither obsolete settings nor connector environment flags can opt out. Unexpected child-side calls are not dispatched as Pi tools and prevent unsafe automatic history restarts.
