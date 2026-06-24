vim.opt.termguicolors = true -- was nvim-only
vim.opt.inccommand = "nosplit" -- was nvim-only

vim.opt.number = true
vim.opt.relativenumber = true
vim.opt.ruler = true
vim.opt.signcolumn = "yes" -- stable gutter for git/diagnostic signs
vim.opt.laststatus = 2
vim.opt.cmdheight = 2

vim.opt.autoindent = true
vim.opt.tabstop = 4
vim.opt.shiftwidth = 4
vim.opt.expandtab = false -- noexpandtab
vim.opt.backspace = { "indent", "eol", "start" }

vim.opt.hlsearch = true
vim.opt.ignorecase = true
vim.opt.smartcase = true
vim.opt.incsearch = true

vim.opt.mouse = "a"
vim.opt.wildmenu = true
vim.opt.hidden = true
vim.opt.splitbelow = true
vim.opt.updatetime = 500
vim.opt.clipboard:append("unnamedplus")

vim.opt.list = true
vim.opt.listchars = { tab = "· ", extends = ">", precedes = "<", nbsp = "+" }

-- Source a trusted, project-local `.nvim.lua`/`.nvimrc`/`.exrc` from the cwd at startup
vim.opt.exrc = true
