" Syntax Highlighting   
syntax on

"Bar at the bottom
set laststatus=2

" Farbschema
colorscheme torte

" Keine Kompatibiliät mit vi
set nocompatible

" Automatische Einrückung
filetype plugin indent on
set autoindent

" Tablänge auf 4 setzen
set tabstop=4
set shiftwidth=4
"set expandtab

" Maussteuerung anschalten
set mouse=a

" Suchfunktion
set hlsearch 
set ignorecase
set smartcase
set incsearch

" Vim omnicompletion
filetype plugin indent on
set omnifunc=syntaxcomplete#Complete

" Zeilen und Spaltenanzeige
set ruler

" Zeilennummerierung
set number

" Autovervollständigung anzeigen
set wildmenu

" Relative Zeilennummerierung
" set relativenumber

" Mappings
map Y y$

" Mappen von Semikolon auf Doppelpunk
nnoremap ; :
" Dasselbe für Punkt und Doppelpunkt  ( für deutsche Tastatur)
nnoremap . :

"Folding options
set foldmethod=syntax
set foldlevelstart=1

let javaScript_fold=1
let perl_fold=1
let php_folding=1
let r_syntax_folding=1
let ruby_fold=1
let sh_fold_enabled=1
let vimsyn_folding='af'
let xml_syntax_folding=1
