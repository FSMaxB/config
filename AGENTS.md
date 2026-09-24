# Config repo

Personal dotfiles/config repo, installed by symlinking files into `$HOME`.

## Live-edit warning

`install.sh` symlinks most top-level files and directories into `$HOME`, so edits in this repo take effect immediately on the installed system.

## install.sh

Symlinks configs into `$HOME`, sets global git config, and syncs vim (vim-plug) and nvim (lazy.nvim) plugins. The repo must live at `~/config`. Do NOT run it — it is only run manually.

## Binaries

`binaries/download.sh` pins tool versions via the `*_VERSION` variables at the top, verifies checksums, and extracts binaries into `binaries/<OS>/<arch>/`. Those directories are gitignored: the binaries are not committed, and `install.sh` runs the script whenever one of the expected tools is missing for the host platform.

By default the script only downloads the host platform; `--all` gets all three. Downloads happen in a scratch directory, so nothing is left behind in `binaries/` on failure. To bump a version: edit the `*_VERSION` variable, and for bat, jj and tuicr also the pinned digests in `download_platform` (they publish no checksum assets), then re-run the script.

## pi extensions

`pi/extensions/` is symlinked to `~/.pi/agent/extensions`, so every `*.ts` there is loaded globally. Nothing hot-reloads: pi has to be restarted before a change takes effect, and there is no typecheck for these files.

Discovery only picks up `*.ts` and `*/index.ts`, so `pi/extensions/lib/` holds shared modules without being loaded as extensions — never add `lib/index.ts`.

`pi/extensions/claude-bridge/` is a fork of the MIT-licensed `@vanillagreen/pi-claude-bridge` (the `pi-claude` provider that routes turns through Claude Code via the Claude Agent SDK). It keeps the upstream layout (`src/`, `tests/`) behind a thin `index.ts`; its `README.md` lists the differences from upstream and `LICENSE` carries the upstream copyright. It has its own `package.json`; `node_modules/` is gitignored and `install.sh` runs `npm ci` there when it is missing. `npm test` and `npm run typecheck` run offline in that directory. Pi aliases `@earendil-works/*` imports to its own copies, so the pi packages in `devDependencies` only serve tests and typechecking.

The file tools (`read`, `write`, `edit`, `ls`, `find`, `grep`, `delete`) go through the path-permission engine in `pi/extensions/lib/path-permissions.ts`: the repository and the memory, skill, plan and crit directories are allowed by default, other paths prompt, and plan mode makes the repository read-only. Rules are globs, persisted in `~/.pi/agent/path-permissions.json` (always) and the session (session); manage them with `/plan grants`, `/plan allow <glob>` and `/plan deny <glob>`. `read`, `write`, and `edit` wrap Pi's stock implementations while remaining subject to the path-permission engine.

`submit_plan` and `crit_review` (when given a plan file inside the plans directory) commit the plan file into a repository in its plans directory (`~/.pi/agent/plans/<cwd-slug>/`), creating a colocated jj repository (or a git one when jj is missing) on first use. Commit messages are `Submit plan: <name>` and `Review plan: <name>`.

## pi skills

`pi/skills/` is symlinked to `~/.pi/agent/skills`, pi's global skill root. Each skill is `pi/skills/<name>/SKILL.md`. Skills meant for Claude Code as well go in `<name>-skill/` at the top level and are linked into `~/.claude/skills/` instead (see `tuicr-skill`).

## CI

`.github/workflows/ci.yml` runs 7 independent jobs on push to `main`, on pull requests, on `workflow_dispatch`, and weekly (the weekly run catches upstream breakage that a push wouldn't: dead release URLs, and vim-plug plugins, which have no lockfile):

- **shellcheck** / **actionlint** / **stylua**: lint shell scripts, the workflow file itself, and `nvim/`. `.github/scripts/shellcheck.sh` auto-discovers every tracked file with a shell shebang or `.sh` suffix and runs the same way locally.
- **node**: `npm ci` + `npm test` + `npm run typecheck` in every `pi/extensions/*/` directory that has a `package.json` (discovered automatically, so new packages need no workflow change but must define both scripts), plus `node --test pi/extensions/*/*.test.ts` for the package-less directories (`lib`, `subagent`; the `lib` tests need `fd` on `PATH`). Matrixed on the `engines` floor (22.19.0) and `latest`.
- **nvim**: installs plugins from `nvim/lazy-lock.json` via `Lazy! restore`, then runs `.github/scripts/nvim-check.lua` headless, which force-loads every plugin and fails on any config error. Matrixed on `v0.12.0` (the floor, since `nvim-treesitter` on `main` requires it) and `stable`. `nvim-check.lua` runs the same way locally: `nvim --headless --cmd "luafile .github/scripts/nvim-check.lua"`.
- **vim**: installs plugins with vim-plug and checks for startup errors. vim-plug has no lockfile, so this always tests upstream HEAD — the weekly run is what surfaces breakage here.
- **downloads**: runs `binaries/download.sh` and smoke-tests every binary, natively on all three supported platforms (`ubuntu-26.04`, `ubuntu-26.04-arm`, `macos-26`).

All actions are pinned to version tags; Dependabot (`.github/dependabot.yml`) keeps them current.

## Vendored code

`.vim/plugged/` and lazy.nvim-managed plugins are third-party — never hand-edit them. `nvim/lazy-lock.json` is machine-managed.

## Gotchas

- `README.md` is outdated: it predates several of the configs in this repo and doesn't mention `install.sh`.
