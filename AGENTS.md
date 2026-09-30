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

`pi/extensions/i-have-adhd/` is a fork of the MIT-licensed `ayghri/i-have-adhd` (an output-style mode toggled with `/i-have-adhd`). The ruleset is `pi/skills/i-have-adhd/SKILL.md`, which the extension reads on load, so edit the rules there. Both directories carry the upstream `LICENSE`; the extension's `README.md` has the upstream commit and the differences. It is not listed under `packages` in `settings.json` anymore; re-adding it would register the command twice.

The file tools (`read`, `write`, `edit`, `ls`, `find`, `grep`, `delete`) go through the path-permission engine in `pi/extensions/lib/path-permissions.ts`: the repository and the memory, skill, plan and crit directories are allowed by default (plus the session scratch directory returned by `temp_dir`, which subagents inherit from their parent through `PI_SESSION_TEMP_DIR`), other paths prompt, and plan mode makes the repository read-only. Rules are globs, persisted in `~/.pi/agent/path-permissions.json` (always) and the session (session); manage them with `/plan grants`, `/plan allow <glob>` and `/plan deny <glob>`. `read`, `write`, and `edit` wrap Pi's stock implementations while remaining subject to the path-permission engine.

`pi/extensions/sandbox/` overrides the built-in `bash` with one that runs every command inside `@anthropic-ai/sandbox-runtime` (pinned exactly: research preview, config format may change): Seatbelt on macOS, bubblewrap + seccomp on Linux (`sudo pacman -S bubblewrap socat ripgrep`; without them bash fails closed with an install hint). The per-command filesystem policy is derived from the path-permission engine (`currentPolicy()`), so the OS enforces the same read/write rules as the file tools. `$HOME` is deny-read except the engine's read-allowed trees plus a toolchain list, and a built-in secret list (`.ssh`, `.aws`, `.gnupg`, pi auth files, ...) is denied for reads and writes even when a broad grant exists. After a failed command, denied paths are prompted once each and recorded as ordinary path rules; the agent has to rerun. Network is deny-all except the allowlist in `~/.pi/agent/sandbox.json` (optional; defaults cover GitHub, npm, crates.io and PyPI) and interactive host prompts. `PI_SANDBOX=0` skips the extension and restores stock bash; that also happens silently if the extension fails to load (e.g. `node_modules/` missing), so restart pi and check that the bash tool description mentions the sandbox. Plan mode leaves bash ungated while the sandbox is active, since the sandbox makes the repository read-only. `bash` also takes `unsandboxed: true` for commands the sandbox itself breaks: the user confirms each one in a prompt whose preselected answer is allow, or deny in plan mode ("in session" answers hold until pi restarts, they are not persisted); subagents are refused outright, and the call line is marked `unsandboxed $`.

The path engine also has a protected write layer: `pi/extensions/**`, `pi/skills/**` (through their `~/.pi/agent/...` symlinks), the global skill roots, `~/.pi/agent/*.json`, `install/`, `bin/` and `npm/` prompt for writes instead of being default-allowed, for the file tools and the sandbox alike. An explicit session or always grant still works (beware: a grant of a parent such as the home directory covers them).

Sandbox limitations (each a candidate for `unsandboxed: true`): programs that ignore proxy environment variables have no network, and ssh git remotes do not work (use https); no listening sockets unless `network.allowLocalBinding` is set in `sandbox.json` (dev servers need it); on Linux glob write allows are dropped and glob write denies widen to their base directory; `git remote add` and `git config` inside the repository fail because srt protects `.git/config` and `.git/hooks`; every other dotfile in `~/config` is still default-allowed for writes; subagent children in plan mode still have no bash.

`submit_plan` and `crit_review` (when given a plan file inside the plans directory) commit the plan file into a repository in its plans directory (`~/.pi/agent/plans/<cwd-slug>/`), creating a colocated jj repository (or a git one when jj is missing) on first use. Commit messages are `Submit plan: <name>` and `Review plan: <name>`.

## pi skills

`pi/skills/` is symlinked to `~/.pi/agent/skills`, pi's global skill root. Each skill is `pi/skills/<name>/SKILL.md`. Skills meant for Claude Code as well go in `<name>-skill/` at the top level and are linked into `~/.claude/skills/` instead (see `tuicr-skill`).

## pi packages

`pi/npm/` holds `package.json` and `package-lock.json` for the npm packages in `settings.json`. `install.sh` symlinks both into `~/.pi/agent/npm` (pi's npm install root, whose own `.gitignore` ignores everything else) and runs `npm ci` there when `node_modules` is missing. `pi update --extensions` runs `npm install <name>@latest` there, which rewrites the repo files through the symlinks (npm writes through them, verified), so review and commit the diff after each update. Git packages have no lockfile: their commit is only recorded in the checkout under `~/.pi/agent/git/`.

## CI

`.github/workflows/ci.yml` runs 8 independent jobs on push to `main`, on pull requests, on `workflow_dispatch`, and weekly (the weekly run catches upstream breakage that a push wouldn't: dead release URLs, and vim-plug plugins, which have no lockfile):

- **shellcheck** / **actionlint** / **stylua**: lint shell scripts, the workflow file itself, and `nvim/`. `.github/scripts/shellcheck.sh` auto-discovers every tracked file with a shell shebang or `.sh` suffix and runs the same way locally.
- **node**: `npm ci` + `npm test` + `npm run typecheck` in every `pi/extensions/*/` directory that has a `package.json` (discovered automatically, so new packages need no workflow change but must define both scripts), plus `node --test pi/extensions/*/*.test.ts` for the package-less directories (`lib`, `subagent`; the `lib` tests need `fd` on `PATH`). Matrixed on the `engines` floor (22.19.0) and `latest`.
- **nvim**: installs plugins from `nvim/lazy-lock.json` via `Lazy! restore`, then runs `.github/scripts/nvim-check.lua` headless, which force-loads every plugin and fails on any config error. Matrixed on `v0.12.0` (the floor, since `nvim-treesitter` on `main` requires it) and `stable`. `nvim-check.lua` runs the same way locally: `nvim --headless --cmd "luafile .github/scripts/nvim-check.lua"`.
- **vim**: installs plugins with vim-plug and checks for startup errors. vim-plug has no lockfile, so this always tests upstream HEAD — the weekly run is what surfaces breakage here.
- **downloads**: runs `binaries/download.sh` and smoke-tests every binary, natively on all three supported platforms (`ubuntu-26.04`, `ubuntu-26.04-arm`, `macos-26`).
- **sandbox**: runs `npm run test:int` in `pi/extensions/sandbox/` natively on `ubuntu-26.04` (with bubblewrap installed and the AppArmor userns restriction lifted) and `macos-26`; it drives the real sandbox, unlike the unit tests in the node job.

All actions are pinned to version tags; Dependabot (`.github/dependabot.yml`) keeps them current.

## Vendored code

`.vim/plugged/` and lazy.nvim-managed plugins are third-party — never hand-edit them. `nvim/lazy-lock.json` is machine-managed.

## Gotchas

- `README.md` is outdated: it predates several of the configs in this repo and doesn't mention `install.sh`.
