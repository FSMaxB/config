#!/bin/bash
if [[ "$(readlink -f "$0")" != "$(readlink -f ~/config/install.sh)" ]]; then
   echo config needs to be installed in ~/config!
   exit 1
fi

# Files that get symlinked to home
HOME_FILES=( .ansi-colors .bashrc-common .tmux.conf .vimrc .vim .nvim .nvimrc .git_template .gitignore_global )


for file in ${HOME_FILES[@]}; do
   if [[ ! -e ~/$file ]]; then
      ln -sv ~/config/$file ~/$file
   else
      echo ~/$file already exists, omitting
   fi
done

hash git 2> /dev/null && git config --global init.templatedir '~/.git_template'
hash git 2> /dev/null && git config --global ui.color true
hash git 2> /dev/null && git config --global core.editor vim
hash git 2> /dev/null && git config --global core.excludesfile ~/.gitignore_global

hash vim 2> /dev/null && vim +PlugInstall +qall
hash vim 2> /dev/null && vim +GitGutterEnable +qall


echo Enable the bash config by adding the following to your ~/.bashrc:
echo GITBRANCH=''
echo source ~/.bashrc-config

