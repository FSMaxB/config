" Syntax Highlighting   
syntax on

" Keine Kompatibiliät mit vi
set nocompatible

" Automatische Einrückung
filetype plugin indent on
set autoindent

" Tablänge auf 4 setzen
set tabstop=4
set shiftwidth=4
set expandtab

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
