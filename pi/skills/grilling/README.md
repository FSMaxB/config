# grilling (fork)

This directory is a fork of the `grilling` skill from [`mattpocock/skills`](https://github.com/mattpocock/skills) (`skills/productivity/grilling/`) at commit `abeeaf95660ba9e8b7c753eb38f441ca707a8823` by Matt Pocock, published under the MIT license. The upstream copyright notice and license text are kept in [LICENSE](LICENSE); modifications made here are copyright Max Bruckner and released under the same license. The first commit touching this directory is the upstream import, with only the `license` field added to the frontmatter, so `jj diff` from that commit shows every later local change.

Differences from upstream:

- The plain-text format for a round of questions (the `❓`/`➡️` template and "word each question so 'yes' accepts your recommended answer") is removed.
- Only `SKILL.md` is kept. `agents/openai.yaml` (Codex display metadata) is not copied.
- `install.sh` links the skill into `~/.claude/skills/` as well, because the `planning` skill refers to it.
