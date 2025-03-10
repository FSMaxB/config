#!/bin/bash
if [[ "$(readlink -f "$0")" != "$(readlink -f ~/config/install.sh)" ]]; then
   echo config needs to be installed in ~/config!
   exit 1
fi

# Files that get symlinked to home
HOME_FILES=( .ansi-colors .bashrc-common .tmux.conf .vimrc .vim .git_template .gitignore_global )


for file in ${HOME_FILES[@]}; do
   if [[ ! -e ~/$file ]]; then
      ln -sv ~/config/$file ~/$file
   else
      echo ~/$file already exists, omitting
   fi
done

if [[ ! -e ~/.config ]]; then
  mkdir ~/.config
fi
if [[ ! -e ~/.config/nvim ]]; then
  ln -s ~/config/.vim ~/.config/nvim
fi
if [[ ! -e ~/.config/nvim/init.vim ]]; then
  ln -s ~/config/.vimrc ~/.config/nvim/init.vim
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

hash git 2> /dev/null && git config --global init.templatedir '~/.git_template'
hash git 2> /dev/null && git config --global ui.color true
if hash nvim 2> /dev/null; then
  hash git 2> /dev/null && git config --global core.editor nvim
elif hash vim 2> /dev/null; then
  hash git 2> /dev/null && git config --global core.editor vim
fi
hash git 2> /dev/null && git config --global core.excludesfile ~/.gitignore_global
hash git 2> /dev/null && git config --global transfer.fsckobjects true
hash git 2> /dev/null && git config --global rerere.enabled true
hash git 2> /dev/null && git config --global push.autoSetupRemote true
hash git 2> /dev/null && git config --global init.defaultBranch main
# https://blog.gitbutler.com/how-git-core-devs-configure-git/
hash git 2> /dev/null && git config --global diff.algorithm histogram
hash git 2> /dev/null && git config --global diff.colorMoved plain
hash git 2> /dev/null && git config --global diff.renames true
hash git 2> /dev/null && git config --global merge.conflictstyle zdiff3

hash vim 2> /dev/null && vim +PlugInstall +qall
hash vim 2> /dev/null && vim +GitGutterEnable +qall


echo Enable the bash config by adding the following to your ~/.bashrc:
echo GITBRANCH=''
echo source ~/.bashrc-config

