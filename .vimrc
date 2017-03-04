" disable vi compatibility
set nocompatible

call plug#begin('~/.vim/plugged')

Plug 'tpope/vim-sensible' "sensible defaults
Plug 'tpope/vim-surround' "work with parentheses etc.
Plug 'tpope/vim-fugitive' "allround git plugin
Plug 'tpope/vim-commentary' "commenting out code
Plug 'tpope/vim-sleuth' "autodetect indentation and tabs
Plug 'bling/vim-airline' "pretty status line
Plug 'airblade/vim-gitgutter' "indicate changed lines
Plug 'morhetz/gruvbox' "fancy colorscheme
Plug 'Raimondi/delimitMate' "automatically close delimiters
Plug 'docunext/closetag.vim' "autoclose html tags
Plug 'ervandew/supertab' "use tab for autocompletion
Plug 'scrooloose/nerdtree' "Directory tree
Plug 'vim-scripts/Gundo' "Undo tree
Plug 'mattn/emmet-vim' "snippet engine
Plug 'skammer/vim-css-color' "display css colors in the correct color
Plug 'pangloss/vim-javascript' "improved javascript highlighting
Plug 'LaTeX-Box-Team/LaTeX-Box' "improved LaTeX support
Plug 'bitc/vim-bad-whitespace' "highlight disgusting whitespace
Plug 'vim-scripts/visualstar.vim' "search for highlighted text with '*'
Plug 'fidian/hexmode' "Hex-Editor
Plug 'nathanaelkane/vim-indent-guides' "show indentation levels
"Lua plugins
Plug 'xolox/vim-misc' "dependency of vim-lua-inspect
Plug 'xolox/vim-lua-inspect' "lua linting

Plug 'godlygeek/tabular' "lining up text
Plug 'plasticboy/vim-markdown'
Plug 'sheerun/vim-polyglot'

Plug 'ctrlpvim/ctrlp.vim' "fuzzy file finder/opener
Plug 'tpope/vim-dispatch' "asynchronous command execution
Plug 'scrooloose/syntastic' "syntax checking in many languages
"Omnisharp
Plug 'OmniSharp/Omnisharp-vim'

call plug#end()

"colorscheme
"let g:gruvbox_italic=1
let g:gruvbox_contrast_dark="hard"
let g:gruvbox_improved_warnings=1
colorscheme gruvbox
set background=dark

"relative line numbers
set relativenumber

set termguicolors

"enable and configure IndentGuides
let g:indent_guides_guide_size = 1
autocmd VimEnter * IndentGuidesEnable

"keymapping for gundo
nnoremap <f5> :GundoToggle<cr>

"Use Ag with ack.vim if available
if executable('ag')
    let g:ackprg = 'ag --vimgrep'
endif

filetype plugin indent on

" syntax highlighting
syntax on

let g:javascript_plugin_jsdoc = 1

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

"--------------------------------------------------------
"omnisharp
" OmniSharp won't work without this setting
filetype plugin on

"This is the default value, setting it isn't actually necessary
let g:OmniSharp_host = "http://localhost:2000"

"Set the type lookup function to use the preview window instead of the status line
"let g:OmniSharp_typeLookupInPreview = 1

"Timeout in seconds to wait for a response from the server
let g:OmniSharp_timeout = 1

"Showmatch significantly slows down omnicomplete
"when the first match contains parentheses.
set noshowmatch

"Super tab settings - uncomment the next 4 lines
"let g:SuperTabDefaultCompletionType = 'context'
"let g:SuperTabContextDefaultCompletionType = "<c-x><c-o>"
"let g:SuperTabDefaultCompletionTypeDiscovery = ["&omnifunc:<c-x><c-o>","&completefunc:<c-x><c-n>"]
"let g:SuperTabClosePreviewOnPopupClose = 1

"don't autoselect first item in omnicomplete, show if only one item (for preview)
"remove preview if you don't want to see any documentation whatsoever.
set completeopt=longest,menuone,preview
" Fetch full documentation during omnicomplete requests.
" There is a performance penalty with this (especially on Mono)
" By default, only Type/Method signatures are fetched. Full documentation can still be fetched when
" you need it with the :OmniSharpDocumentation command.
" let g:omnicomplete_fetch_documentation=1

"Move the preview window (code documentation) to the bottom of the screen, so it doesn't move the code!
"You might also want to look at the echodoc plugin
set splitbelow

" Get Code Issues and syntax errors
let g:syntastic_cs_checkers = ['syntax', 'semantic', 'issues']
" If you are using the omnisharp-roslyn backend, use the following
" let g:syntastic_cs_checkers = ['code_checker']
augroup omnisharp_commands
    autocmd!

    "Set autocomplete function to OmniSharp (if not using YouCompleteMe completion plugin)
    autocmd FileType cs setlocal omnifunc=OmniSharp#Complete

    " Synchronous build (blocks Vim)
    "autocmd FileType cs nnoremap <F5> :wa!<cr>:OmniSharpBuild<cr>
    " Builds can also run asynchronously with vim-dispatch installed
    autocmd FileType cs nnoremap <leader>b :wa!<cr>:OmniSharpBuildAsync<cr>
    " automatic syntax check on events (TextChanged requires Vim 7.4)
    autocmd BufEnter,TextChanged,InsertLeave *.cs SyntasticCheck

    " Automatically add new cs files to the nearest project on save
    autocmd BufWritePost *.cs call OmniSharp#AddToProject()

    "show type information automatically when the cursor stops moving
    autocmd CursorHold *.cs call OmniSharp#TypeLookupWithoutDocumentation()

    "The following commands are contextual, based on the current cursor position.

    autocmd FileType cs nnoremap gd :OmniSharpGotoDefinition<cr>
    autocmd FileType cs nnoremap <leader>fi :OmniSharpFindImplementations<cr>
    autocmd FileType cs nnoremap <leader>ft :OmniSharpFindType<cr>
    autocmd FileType cs nnoremap <leader>fs :OmniSharpFindSymbol<cr>
    autocmd FileType cs nnoremap <leader>fu :OmniSharpFindUsages<cr>
    "finds members in the current buffer
    autocmd FileType cs nnoremap <leader>fm :OmniSharpFindMembers<cr>
    " cursor can be anywhere on the line containing an issue
    autocmd FileType cs nnoremap <leader>x  :OmniSharpFixIssue<cr>
    autocmd FileType cs nnoremap <leader>fx :OmniSharpFixUsings<cr>
    autocmd FileType cs nnoremap <leader>tt :OmniSharpTypeLookup<cr>
    autocmd FileType cs nnoremap <leader>dc :OmniSharpDocumentation<cr>
    "navigate up by method/property/field
    autocmd FileType cs nnoremap <C-K> :OmniSharpNavigateUp<cr>
    "navigate down by method/property/field
    autocmd FileType cs nnoremap <C-J> :OmniSharpNavigateDown<cr>

augroup END


" this setting controls how long to wait (in ms) before fetching type / symbol information.
set updatetime=500
" Remove 'Press Enter to continue' message when type information is longer than one line.
set cmdheight=2

" Contextual code actions (requires CtrlP or unite.vim)
nnoremap <leader><space> :OmniSharpGetCodeActions<cr>
" Run code actions with text selected in visual mode to extract method
vnoremap <leader><space> :call OmniSharp#GetCodeActions('visual')<cr>

" rename with dialog
nnoremap <leader>nm :OmniSharpRename<cr>
nnoremap <F2> :OmniSharpRename<cr>
" rename without dialog - with cursor on the symbol to rename... ':Rename newname'
command! -nargs=1 Rename :call OmniSharp#RenameTo("<args>")

" Force OmniSharp to reload the solution. Useful when switching branches etc.
nnoremap <leader>rl :OmniSharpReloadSolution<cr>
nnoremap <leader>cf :OmniSharpCodeFormat<cr>
" Load the current .cs file to the nearest project
nnoremap <leader>tp :OmniSharpAddToProject<cr>

" (Experimental - uses vim-dispatch or vimproc plugin) - Start the omnisharp server for the current solution
nnoremap <leader>ss :OmniSharpStartServer<cr>
nnoremap <leader>sp :OmniSharpStopServer<cr>

" Add syntax highlighting for types and interfaces
nnoremap <leader>th :OmniSharpHighlightTypes<cr>
"Don't ask to save when changing buffers (i.e. when jumping to a type definition)
set hidden

" Enable snippet completion, requires completeopt-=preview
let g:OmniSharp_want_snippet=1
