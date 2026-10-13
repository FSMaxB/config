# pi themes

`install.sh` symlinks this directory to `~/.pi/agent/themes`, pi's global theme directory (the only one pi hot-reloads). pi loads every `*.json` here and ignores the other files.

`gruvbox-dark.json` comes from the MIT-licensed npm package [`@firstpick/pi-themes-bundle`](https://github.com/Firstp1ck/pi-coding-agent-forge/tree/main/pi-package-themes-bundle) version 0.1.6 by Firstpick. The upstream copyright notice and license text are kept in [LICENSE](LICENSE); modifications made here are copyright Max Bruckner and released under the same license. Diff against `themes/gruvbox-dark.json` in the published 0.1.6 package to see every local change.

Differences from upstream:

- `$schema` points at `https://pi.dev/schemas/theme.schema.json`; the upstream raw GitHub URL returns 404.
- Only `gruvbox-dark` is kept; the other themes of the bundle are not copied.
