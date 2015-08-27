" disable vi compatibility
set nocompatible

call plug#begin('~/.vim/plugged')

Plug 'tpope/vim-sensible'
Plug 'tpope/vim-surround'
Plug 'tpope/vim-fugitive'
Plug 'tpope/vim-commentary'
Plug 'tpope/vim-sleuth'
Plug 'bling/vim-airline'
Plug 'airblade/vim-gitgutter'
Plug 'morhetz/gruvbox'
Plug 'Raimondi/delimitMate'
Plug 'docunext/closetag.vim'
Plug 'ervandew/supertab'
Plug 'scrooloose/nerdtree'
Plug 'vim-scripts/Gundo'
Plug 'mattn/emmet-vim'
Plug 'mileszs/ack.vim'
Plug 'skammer/vim-css-color'
Plug 'tpope/vim-abolish'
Plug 'pangloss/vim-javascript'
Plug 'LaTeX-Box-Team/LaTeX-Box'
Plug 'bitc/vim-bad-whitespace'
Plug 'vim-scripts/visualstar.vim'
Plug 'terryma/vim-multiple-cursors'
" \cr to get reference
Plug 'vim-scripts/CRefVim'

call plug#end()

"keymapping for gundo
nnoremap <f5> :GundoToggle<cr>

"Use Ag with ack.vim if available
if executable('ag')
    let g:ackprg = 'ag --vimgrep'
endif

filetype plugin indent on

" syntax highlighting
syntax on

"bar at the bottom
set laststatus=2

" more powerful backspace
set backspace=indent,eol,start

" colorscheme
colorscheme torte

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

" show tabs
set list
set listchars=tab:·\ ,extends:>,precedes:<,nbsp:+
