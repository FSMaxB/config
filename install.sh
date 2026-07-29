#!/bin/bash
if [[ "$(readlink -f "$0")" != "$(readlink -f ~/config/install.sh)" ]]; then
  echo config needs to be installed in ~/config!
  exit 1
fi

# Files that get symlinked to home
HOME_FILES=(.ansi-colors .shellrc-common .tmux.conf .vimrc .vim .git_template .gitignore_global)

for file in "${HOME_FILES[@]}"; do
  if [[ -L ~/$file || ! -e ~/$file ]]; then
    # Re-point symlinks we own (this self-heals after ~/config is moved),
    # but never clobber a real file the user already has there.
    ln -sfnv ~/config/$file ~/$file
  else
    echo ~/$file already exists, omitting
  fi
done

mkdir -p ~/.config
if [[ -L ~/.config/nvim || ! -e ~/.config/nvim ]]; then
  # Re-point the symlink we own (self-heals the old ~/.config/nvim -> .vim link),
  # but never clobber a real directory the user already has there.
  ln -sfnv ~/config/nvim ~/.config/nvim
else
  echo ~/.config/nvim already exists, omitting
fi
if [[ ! -e ~/.config/starship.toml ]]; then
  ln -s ~/config/starship.toml ~/.config/starship.toml
fi
if [[ ! -e ~/.config/alacritty/alacritty.toml ]]; then
  mkdir -p ~/.config/alacritty
  ln -s ~/config/alacritty.toml ~/.config/alacritty/alacritty.toml
fi
if [[ ! -e ~/.config/helix/config.toml ]]; then
  mkdir -p ~/.config/helix
  ln -s ~/config/helix-config.toml ~/.config/helix/config.toml
fi
if [[ ! -e ~/.config/atuin/config.toml ]]; then
  mkdir -p ~/.config/atuin
  ln -s ~/config/atuin-config.toml ~/.config/atuin/config.toml
fi
if [[ ! -e ~/.config/tuicr/config.toml ]]; then
  mkdir -p ~/.config/tuicr
  ln -s ~/config/tuicr-config.toml ~/.config/tuicr/config.toml
fi

if [[ ! -e ~/.claude/CLAUDE.md ]]; then
  mkdir -p ~/.claude
  ln -s ~/config/INSTALL-CLAUDE.md ~/.claude/CLAUDE.md
fi
if [[ ! -e ~/.claude/skills/tuicr ]]; then
  mkdir -p ~/.claude/skills
  ln -s ~/config/tuicr-skill ~/.claude/skills/tuicr
fi
if [[ ! -e ~/.agents/skills/tuicr ]]; then
  mkdir -p ~/.agents/skills
  ln -s ~/config/tuicr-skill ~/.agents/skills/tuicr
fi
if [[ ! -e ~/.pi/agent/CLAUDE.md ]]; then
  mkdir -p ~/.pi/agent
  ln -s ~/config/INSTALL-CLAUDE.md ~/.pi/agent/CLAUDE.md
fi
if [[ -L ~/.pi/agent/extensions || ! -e ~/.pi/agent/extensions ]]; then
  mkdir -p ~/.pi/agent
  ln -sfnv ~/config/pi/extensions ~/.pi/agent/extensions
fi
if [[ -L ~/.pi/agent/settings.json || ! -e ~/.pi/agent/settings.json ]]; then
  mkdir -p ~/.pi/agent
  ln -sfnv ~/config/pi/settings.json ~/.pi/agent/settings.json
fi
if [[ -L ~/.pi/agent/APPEND_SYSTEM.md || ! -e ~/.pi/agent/APPEND_SYSTEM.md ]]; then
  mkdir -p ~/.pi/agent
  ln -sfnv ~/config/pi/APPEND_SYSTEM.md ~/.pi/agent/APPEND_SYSTEM.md
fi
if [[ -L ~/.pi/agent/claude-bridge.json || ! -e ~/.pi/agent/claude-bridge.json ]]; then
  mkdir -p ~/.pi/agent
  ln -sfnv ~/config/pi/claude-bridge.json ~/.pi/agent/claude-bridge.json
fi

if hash git 2>/dev/null; then
  git config --global init.templatedir '~/.git_template'
  git config --global color.ui true
  if hash nvim 2>/dev/null; then
    git config --global core.editor nvim
  elif hash vim 2>/dev/null; then
    git config --global core.editor vim
  fi
  git config --global core.excludesfile ~/.gitignore_global
  git config --global transfer.fsckobjects true
  git config --global rerere.enabled true
  git config --global push.autoSetupRemote true
  git config --global init.defaultBranch main
  # https://blog.gitbutler.com/how-git-core-devs-configure-git/
  git config --global diff.algorithm histogram
  git config --global diff.colorMoved plain
  git config --global diff.renames true
  git config --global merge.conflictstyle zdiff3
fi

hash vim 2>/dev/null && vim +PlugInstall +qall
hash vim 2>/dev/null && vim +GitGutterEnable +qall
hash nvim 2>/dev/null && nvim --headless "+Lazy! sync" +qa

echo "Enable the shell config by sourcing it from your shell rc:"
echo "  bash: add 'source ~/.shellrc-common' to ~/.bashrc"
echo "  zsh:  add 'source ~/.shellrc-common' to ~/.zshrc"
