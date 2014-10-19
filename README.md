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

You can configure this script by setting different environment variables in your bashrc (the content of the variables doesn't matter):

* **GITBRANCH**: If you're in a git repository, this shows the name of the currently checked out branch in your prompt.
* **FORTUNE**: This needs `cowsay` and `fortune` installed in order to work. Displays tux saying some fortune cookie text.
* **FREESPACE**: Shows the free space left on different partitions using `df`.

.capslock
---------
Run `xmodmap ~/.capslock` after putting this file to your home directory in order to map the CapsLock key to the Escape key. This is really helpful for using vim.

.german-chars
--------
Run `xmodmap ~/.german-chars` after putting this file to your home directory in order to write ÄÖÜäöüß€ when pressing the Menu key and AOUaouse. I use this to write german characters on a US keyboard layout ( great for programming )

.conkyrc
--------
Conky configuration file. Put this in your home directory. This file is a modified version of the one used by PartedMagic (http://www.partedmagig.com).

de-latin1-nocaps.map.gz
-----------------------
de-latin1 keymap for the virtual console with a modification to make CapsLock trigger Escape. Put this in `/usr/share/kbd/keymaps/i386/qwertz/`. You can enable this by writing `KEYMAP=de-latin1-nocaps` to `/etc/vconsole.conf`. The last file may differ depending on the distribution.

.fehbg
------
This loads `~/.wallpaper` as the desktop wallpaper. This only works with simple window managers like openbox or i3, don't use this when you use a full desktop environment like GNOME or KDE.

htoprc
------
Htop configuration file. Put this in `~/.config/htop/`

.vimrc
------
Vim configuration file. Put this in your home directory.

.tmux.config
------------
Tmux cofiguration file. Sets vi keybindings for the scrollback buffer, enables mouse support and increases the buffer size.

.git_template
-------------
Directory that contains git hooks. At the time it's a post-commit hook that runs the `sync` command after every commit ( to prevent data loss ). Symlink or copy this directory to your home directory and enable it with `git config --global init.templatedir '~/.git_template'`. Run `git init` in every git repository where you want to enable it. 
