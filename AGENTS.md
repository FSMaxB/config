# Config repo

Personal dotfiles/config repo, installed by symlinking files into `$HOME`.

## Live-edit warning

`install.sh` symlinks most top-level files and directories into `$HOME`, so edits in this repo take effect immediately on the installed system.

## install.sh

Symlinks configs into `$HOME`, sets global git config, and syncs vim (vim-plug) and nvim (lazy.nvim) plugins. The repo must live at `~/config`. Do NOT run it — it is only run manually.

## Binaries

`binaries/download.sh` pins tool versions via the `*_VERSION` variables at the top, verifies checksums, and extracts binaries into `binaries/<OS>/<arch>/`. Those directories are gitignored: the binaries are not committed, and `install.sh` runs the script whenever one of the expected tools is missing for the host platform.

By default the script only downloads the host platform; `--all` gets all four. Downloads happen in a scratch directory, so nothing is left behind in `binaries/` on failure. To bump a version: edit the `*_VERSION` variable, and for bat, jj and tuicr also the pinned digests in `download_platform` (they publish no checksum assets), then re-run the script.

## pi extensions

`pi/extensions/` is symlinked to `~/.pi/agent/extensions`, so every `*.ts` there is loaded globally. Nothing hot-reloads: pi has to be restarted before a change takes effect, and there is no typecheck for these files.

Discovery only picks up `*.ts` and `*/index.ts`, so `pi/extensions/lib/` holds shared modules without being loaded as extensions — never add `lib/index.ts`.

The file tools (`read`, `write`, `edit`, `ls`, `find`, `grep`, `delete`) go through the path-permission engine in `pi/extensions/lib/path-permissions.ts`: the repository and the memory, skill, plan and crit directories are allowed by default, other paths prompt, and plan mode makes the repository read-only. Rules are globs, persisted in `~/.pi/agent/path-permissions.json` (always) and the session (session); manage them with `/plan grants`, `/plan allow <glob>` and `/plan deny <glob>`. `read`, `write`, and `edit` wrap Pi's stock implementations while remaining subject to the path-permission engine.

`submit_plan` and `crit_review` (when given a plan file inside the plans directory) commit the plan file into a repository in its plans directory (`~/.pi/agent/plans/<cwd-slug>/`), creating a colocated jj repository (or a git one when jj is missing) on first use. Commit messages are `Submit plan: <name>` and `Review plan: <name>`.

## pi skills

`pi/skills/` is symlinked to `~/.pi/agent/skills`, pi's global skill root. Each skill is `pi/skills/<name>/SKILL.md`. Skills meant for Claude Code as well go in `<name>-skill/` at the top level and are linked into `~/.claude/skills/` instead (see `tuicr-skill`).

## Vendored code

`.vim/plugged/` and lazy.nvim-managed plugins are third-party — never hand-edit them. `nvim/lazy-lock.json` is machine-managed.

## Gotchas

- `README.md` is outdated: it predates several of the configs in this repo and doesn't mention `install.sh`.
