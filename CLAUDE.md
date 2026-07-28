# Config repo

Personal dotfiles/config repo, installed by symlinking files into `$HOME`.

## Live-edit warning

`install.sh` symlinks most top-level files and directories into `$HOME`, so edits in this repo take effect immediately on the installed system.

## install.sh

Symlinks configs into `$HOME`, sets global git config, and syncs vim (vim-plug) and nvim (lazy.nvim) plugins. The repo must live at `~/config`. Do NOT run it — it is only run manually.

## Binaries

`binaries/download.sh` pins tool versions via the `*_VERSION` variables at the top, verifies checksums, and extracts binaries into `binaries/<OS>/<arch>/`. To bump a version: edit the variable, re-run the script.

## pi extensions

`pi/extensions/` is symlinked to `~/.pi/agent/extensions`, so every `*.ts` there is loaded globally. Nothing hot-reloads: pi has to be restarted before a change takes effect, and there is no typecheck for these files.

Discovery only picks up `*.ts` and `*/index.ts`, so `pi/extensions/lib/` holds shared modules without being loaded as extensions — never add `lib/index.ts`.

## Vendored code

`.vim/plugged/` and lazy.nvim-managed plugins are third-party — never hand-edit them. `nvim/lazy-lock.json` is machine-managed.

## Gotchas

- `README.md` is outdated: it predates several of the configs in this repo and doesn't mention `install.sh`.
