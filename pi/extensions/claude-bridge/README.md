# pi-claude-bridge (fork)

A Pi provider that uses a logged-in Claude Code account through the Claude Agent SDK. You keep Pi's terminal interface and tools while Claude Code handles model requests.

## About this fork

This directory is a fork of [`@vanillagreen/pi-claude-bridge`](https://github.com/vanillagreencom/kendex/tree/main/pi-extensions/pi-claude-bridge) 4.0.2 by Eli Dickinson (vanillagreen), published under the MIT license. The upstream copyright notice and license text are kept in [LICENSE](LICENSE); modifications made here are copyright Max Bruckner and released under the same license. The first commit touching this directory is the unmodified upstream import, so `jj diff` from that commit shows every local change.

Differences from upstream:

- Pi loads the extension from source: `index.ts` re-exports `src/index.ts`, so there is no `bundle/` build step and no `esbuild`. The upstream `./connector-inventory` entry point and the `bundle/`-based artifact test are gone; everything else is still exported from `src/index.ts`.
- Dependencies come from this directory's own `package.json`; `zod` and `@modelcontextprotocol/sdk` are declared explicitly because the bundle no longer inlines them.
- The kendex extension-manager manifest (the `kendex` block in upstream `package.json`) is not carried over. The settings it described still work when written to `kendex.extensionManager.config["@vanillagreen/pi-claude-bridge"]` in Pi's settings, or to `claude-bridge.json`.

## Install

The extension lives in `~/config/pi/extensions/claude-bridge/`, which `install.sh` symlinks into `~/.pi/agent/extensions/`. Run `npm ci` in this directory once so `node_modules/` exists (`install.sh` does this when it is missing), then restart Pi. A Claude Code login is required. Make `claude` available on `PATH` or set its executable path below.

`npm test` runs the unit tests and `npm run typecheck` runs `tsc`; both work offline. `npm run test:int` needs a logged-in Claude account and the `pi` binary on `PATH`.

Fable 5.1 requires [Claude Code 2.1.255 or later](https://code.claude.com/docs/en/model-config#work-with-fable). This includes any executable chosen through `pathToClaudeCodeExecutable` or found on `PATH`, which takes precedence over the SDK's bundled CLI. Account access and usage-credit requirements still apply.

## Features

- Select Claude models from Pi's model menu.
- Run Pi tool calls during Claude conversations.
- Resume the Claude conversation across Pi turns.
- Configure model effort and forwarded prompt context.
- Optionally use the Claude account's connectors.

## How it works

- You pick one of the `pi-claude` models in Pi's model menu; **Claude Fable 5.1** is `pi-claude/claude-fable-5-1`.
- The bridge starts Claude Code, or resumes it, through the Claude Agent SDK, Anthropic's library for driving Claude Code from another program.
- It sends your prompt to Claude Code and offers it Pi's tools.
- When Claude Code calls a tool, Pi runs the tool and sends the result back to Claude Code.
- Pi shows the reply and remembers which Claude Code conversation it belongs to, so your next message continues it.

## Settings

The settings editor writes project values to `.pi/settings.json`. The default user file is `~/.pi/agent/settings.json`. `PI_CODING_AGENT_DIR` changes the user directory. Package values are stored under `kendex.extensionManager.config["@vanillagreen/pi-claude-bridge"]`.

Open `/extensions:settings`; settings appear under the **Pi Claude** tab, and `/pi-claude` opens the same tab. Project settings in `.pi/settings.json` apply only after Pi marks the workspace trusted. The bridge also reads `claude-bridge.json` in `~/.pi/agent` and in a trusted project's `.pi/`; a value taken from one of those files is shown with the file that supplies it, and editing it in the panel writes Pi settings, which win.

- `enabled`: register the `pi-claude/*` models; reload required.
- `appendSystemPrompt`: the context file and skills block described above.
- `includeAppendSystemPromptMd`, `includeProjectAgentsHook`, `includeTaskPanelHook`, `includeCavemanHook`: forward `APPEND_SYSTEM.md` and the prompt blocks of `pi-agents-tmux`, `pi-task-panel` and `pi-caveman`.
- `strictMcpConfig`, `fastMode`, `pathToClaudeCodeExecutable`: how the Claude Code subprocess is launched.
- `forceEffort`, `modelEffortOverrides`: pin a Claude effort for every request or per model. Override keys are bare ids (`claude-opus-4-8`), `pi-claude/<id>` or `*`; values are `low`, `medium`, `high`, `xhigh` or `max`; a per-model entry beats the global force.

Environment variables:

- `CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT`: how long a turn may stay silent before its first output; bare numbers are seconds, `ms`, `s` and `m` suffixes are accepted, `0` disables.
- `CLAUDE_BRIDGE_DEBUG=1`: write the bridge log, the integrity diagnostics and per-query Claude Code CLI logs under the Pi agent directory; `CLAUDE_BRIDGE_DEBUG_PATH` and `CLAUDE_BRIDGE_DIAG_PATH` move the two log files. Nothing is written to disk without it.
- `CLAUDE_BRIDGE_ISOLATED=1`: for embedding hosts that own every config directory; the bridge then reads nothing from the working directory or home. Details in [DEVELOPMENT.md](DEVELOPMENT.md).

Tool-result integrity problems always surface as a Pi error notification plus a metadata-only `claude-bridge-integrity` entry in the Pi session file, so a lost tool result can be analysed from the session alone.

Maintainer notes, the embedding and account-router contracts, and the test suites are in [DEVELOPMENT.md](DEVELOPMENT.md).

## Prompt context

The bridge sends the nearest context file and Pi's skills list with the prompt. It checks `AGENTS.override.md`, `AGENTS.md` and `AGENTS.MD` while walking up from the working directory. Claude Code loads its own CLAUDE.md files. Use the prompt settings above to forward other Pi extension instructions.

## Connectors

Connectors are disabled by default. Set `enableConnectors` in user settings, user `claude-bridge.json`, or the `CLAUDE_BRIDGE_ENABLE_CONNECTORS` environment variable. Project settings cannot enable them.

Connector access is read-only unless `connectorWriteMode` is exactly `allow`. Set `CLAUDE_BRIDGE_CONNECTOR_WRITE=allow` only for a dedicated process running an approved write. Keep it out of persistent settings. Use `/pi-claude:connectors` to list the account's connectors.

With connectors enabled, Claude Code loads user settings. An explicit `provider.settingSources` list in `claude-bridge.json` changes that selection. Including project or local settings lets those files affect the subprocess.
