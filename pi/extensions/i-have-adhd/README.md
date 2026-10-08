# i-have-adhd (fork)

A Pi extension that injects an output-style ruleset for a reader with ADHD (`/i-have-adhd`, `--adhd`, "stop adhd mode").

## About this fork

This directory and [`pi/skills/i-have-adhd/`](../../skills/i-have-adhd/) are a fork of [`ayghri/i-have-adhd`](https://github.com/ayghri/i-have-adhd) at commit `839872f9d1cd634fed642b4589ce7226199cc15f` by Ayoub Ghriss, published under the MIT license. The upstream copyright notice and license text are kept in [LICENSE](LICENSE) and in the skill directory; modifications made here are copyright Max Bruckner and released under the same license. The first commit touching these directories is the unmodified upstream import, so `jj diff` from that commit shows every local change.

The ruleset itself is `pi/skills/i-have-adhd/SKILL.md`. Edit it there: the extension reads it on load, and it is also the `/skill:i-have-adhd` alias. Restart Pi after changing either file.

Differences from upstream:

- Loaded from this repo (`install.sh` symlinks it into `~/.pi/agent/extensions/`) instead of as the `https://github.com/ayghri/i-have-adhd` package in `settings.json`. The package entry is removed so the extension is not registered twice.
- `extensions/i-have-adhd.ts` is `index.ts` here and reads the skill from `../../skills/i-have-adhd/SKILL.md`.
- Settings live in Pi's main `settings.json` under `iHaveAdhd` instead of `i-have-adhd.json`, and the `.i-have-adhd-always` flag file and the `hideStatus` setting are gone. The only setting is `iHaveAdhd.alwaysOn`.
- `iHaveAdhd.alwaysOn` is skipped on a local model, a Haiku model older than 5.5, a GPT Luna model or a Mistral model (matched by model id, so other models served by the Mistral provider keep the default). Until the first prompt the default follows every model switch (the status bar shows it), and the rules are injected with the first prompt, after the user's message, instead of at session start. Once the session has messages, switching models no longer changes the mode. `--adhd` and a saved session state still win, and `/i-have-adhd on` works as usual. Local is decided by `isLocalModel` from `../subagent/model-policy.ts`.
- Only the Pi parts are kept. The hooks, plugin manifests for other agents, evals and translations are not copied.
