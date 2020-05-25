" disable vi compatibility
set nocompatible

call plug#begin('~/.vim/plugged')

if !has('nvim')
    Plug 'tpope/vim-sensible' "sensible defaults
endif

Plug 'tpope/vim-surround' "work with parentheses etc.
Plug 'tpope/vim-fugitive' "allround git plugin
Plug 'tpope/vim-commentary' "commenting out code
Plug 'tpope/vim-sleuth' "autodetect indentation and tabs
Plug 'bling/vim-airline' "pretty status line
Plug 'airblade/vim-gitgutter' "indicate changed lines
Plug 'morhetz/gruvbox' "fancy colorscheme
Plug 'Raimondi/delimitMate' "automatically close delimiters
Plug 'alvan/vim-closetag' "autoclose html tags
Plug 'ervandew/supertab' "use tab for autocompletion
Plug 'scrooloose/nerdtree' "Directory tree
Plug 'mattn/emmet-vim' "snippet engine
Plug 'pangloss/vim-javascript' "improved javascript highlighting
Plug 'bitc/vim-bad-whitespace' "highlight disgusting whitespace
Plug 'thinca/vim-visualstar' "search for highlighted text with '*'
Plug 'fidian/hexmode' "Hex-Editor
Plug 'nathanaelkane/vim-indent-guides' "show indentation levels

Plug 'godlygeek/tabular' "lining up text
Plug 'plasticboy/vim-markdown'
Plug 'sheerun/vim-polyglot'

Plug 'ctrlpvim/ctrlp.vim' "fuzzy file finder/opener
Plug 'tpope/vim-dispatch' "asynchronous command execution
Plug 'scrooloose/syntastic' "syntax checking in many languages

if has('nvim') && has('python3')
    Plug 'ncm2/ncm2' "Neovim Completion Manager 2
    Plug 'roxma/nvim-yarp' "Dependency of ncm2
    Plug 'ncm2/ncm2-ultisnips'
    Plug 'SirVer/ultisnips'
    Plug 'ncm2/ncm2-tmux' "autocompletion from tmux
    Plug 'ncm2/ncm2-path' "autocompletion from file paths
    Plug 'ncm2/ncm2-bufword' "autocomplete words from buffers
    Plug 'ncm2/ncm2-neoinclude' | Plug 'Shougo/neoinclude.vim'
    if executable('npm')
        Plug 'ncm2/ncm2-tern', {'do': 'npm install'}
    endif
endif

Plug 'machakann/vim-highlightedyank'
Plug 'editorconfig/editorconfig-vim'

call plug#end()

if has('nvim')
    set termguicolors
    set inccommand=nosplit
    let g:chromatica#enable_at_startup=1

    if has('python3')
        autocmd BufEnter * call ncm2#enable_for_buffer()
        set completeopt=noinsert,menuone,noselect
    endif
endif

"colorscheme
if ($TERM == "xterm-256color")
    let g:gruvbox_italic=1
endif
let g:gruvbox_contrast_dark="hard"
let g:gruvbox_improved_warnings=1
colorscheme gruvbox
set background=dark

"relative line numbers
set relativenumber
"enable and configure IndentGuides
let g:indent_guides_guide_size = 1
autocmd VimEnter * IndentGuidesEnable

runtime macros/matchit.vim

filetype plugin indent on

" syntax highlighting
syntax on

"bar at the bottom
set laststatus=2

" more powerful backspace
set backspace=indent,eol,start

" automatic indentation
set autoindent

" set tabwidth to 4 spaces and expand them
set tabstop=4
set shiftwidth=4
set noexpandtab

" enable mouse support
set mouse=a

" improve search
set hlsearch
set ignorecase
set smartcase
set incsearch

"vim-markdown
let g:vim_markdown_folding_disabled=1
let g:vim_markdown_conceal=0

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

"enable xorg clipboard for normal copy and paste!
set clipboard+=unnamedplus

"syntastic
set statusline+=%#warningmsg#
set statusline+=%{SyntasticStatuslineFlag()}
set statusline+=%*
let g:syntastic_always_populate_loc_list = 1
let g:syntastic_auto_loc_list = 1
let g:syntastic_check_on_open = 1
let g:syntastic_check_on_wq = 0
let g:syntastic_aggregate_errors = 1
let g:syntastic_cpp_compiler_options="--std=c++17"

"Move the preview window (code documentation) to the bottom of the screen, so it doesn't move the code!
"You might also want to look at the echodoc plugin
set splitbelow

" Get Code Issues and syntax errors
let g:syntastic_cs_checkers = ['syntax', 'semantic', 'issues']
" If you are using the omnisharp-roslyn backend, use the following
" let g:syntastic_cs_checkers = ['code_checker']

" this setting controls how long to wait (in ms) before fetching type / symbol information.
set updatetime=500
" Remove 'Press Enter to continue' message when type information is longer than one line.
set cmdheight=2

"Don't ask to save when changing buffers (i.e. when jumping to a type definition)
set hidden
