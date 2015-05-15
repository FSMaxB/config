" disable vi compatibility
set nocompatible

call plug#begin('~/.vim/plugged')

Plug 'bling/vim-airline'
Plug 'airblade/vim-gitgutter'
Plug 'morhetz/gruvbox'
Plug 'chriskempson/base16-vim'
Plug 'cschlueter/vim-wombat'
Plug 'Raimondi/delimitMate'

call plug#end()

filetype plugin indent on

" syntax highlighting   
syntax on

"bar at the bottom
set laststatus=2

" more powerful backspace
set backspace=indent,eol,start

" colorscheme
colorscheme wombat256

" automatic indentation
set autoindent

" set tabwidth to 4 spaces and expand them
set tabstop=4
set shiftwidth=4
set expandtab

" enable mouse support
set mouse=a

" improve search
set hlsearch 
set ignorecase
set smartcase
set incsearch

" vim omnicompletion
set omnifunc=syntaxcomplete#Complete

" show row an column
set ruler

" line numbers
set number

" show menu for autocompletion
set wildmenu

" line numbers relative to cursor position
" set relativenumber

" mappings
map Y y$
"comma to window commands
map , <C-w>

" map semicolon to colon
nnoremap ; :
" map Ö to colon to make switching between us and german layout easier
nnoremap Ö :
