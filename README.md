My Config Files
===============

This is a collection of the configuration files I use.

The following files are included:

.ansi-colors
------------
Defines variables for different color codes. This is to be put in your home directory. In my configuration this is loaded by `.bashrc-common`.

.bashrc-common:
--------------
This is more or less my bash configuration file (bashrc). It is to be put in the home directory. In order to enable it, load it in your `~/.bashrc` with `source ~/.bashrc-common`. In order for it to work properly, you need to have `.ansi-colors` installed in your home directory.

.vimrc
------
Vim configuration file. Put this in your home directory. **IMPORTANT:** You also need to put the `.vim` directory in your home and install the plugins with `:PlugInstall` (from inside vim). To additionally enable highlighting changed lines compared to the current git commit, run `:GitGutterEnable`.

.tmux.config
------------
Tmux cofiguration file. Sets vi keybindings for the scrollback buffer, enables mouse support and increases the buffer size.

.git_template
-------------
Directory that contains git hooks. At the time it's a post-commit hook that runs the `sync` command after every commit ( to prevent data loss ). Symlink or copy this directory to your home directory and enable it with `git config --global init.templatedir '~/.git_template'`. Run `git init` in every git repository where you want to enable it.

etc
---
Contains all the system wide config files that I use across my systems.
