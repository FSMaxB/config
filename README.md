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
Script that executes xmodmap with the `.xmodmap` configuration file. You can put this in the autostart of your distribution. This needs the `.xmodmap` file to work.

.xmodmap
--------
Xmodmap configuration file that remaps CaspLock to Escape and enables using the Menu key to write ÄäÖöÜüß and €. You should put this file in your home directory.

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
