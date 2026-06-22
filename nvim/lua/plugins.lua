return {
	-- colorscheme (load eagerly, high priority, port g: vars + colorscheme)
	{
		"morhetz/gruvbox",
		lazy = false,
		priority = 1000,
		init = function()
			vim.g.gruvbox_italic = 1
			vim.g.gruvbox_contrast_dark = "hard"
			vim.g.gruvbox_improved_warnings = 1
		end,
		config = function()
			vim.opt.background = "dark"
			vim.cmd.colorscheme("gruvbox")
		end,
	},

	-- neovim-only plugins (from the has('nvim') branch) — kept unconfigured, as today
	{ "nvim-treesitter/nvim-treesitter", build = ":TSUpdate" },
	{ "neovim/nvim-lspconfig" },
	{ "nvim-telescope/telescope.nvim", dependencies = { "nvim-lua/plenary.nvim" } },

	-- universal plugins
	{ "tpope/vim-surround" },
	{ "tpope/vim-fugitive" },
	{ "tpope/vim-commentary" },
	{ "tpope/vim-sleuth" },
	{ "bling/vim-airline" },
	{ "airblade/vim-gitgutter" },
	{ "Raimondi/delimitMate" },
	{ "alvan/vim-closetag" },
	{ "ervandew/supertab" },
	{ "scrooloose/nerdtree" },
	{ "bitc/vim-bad-whitespace" },
	{ "thinca/vim-visualstar" },
	{ "fidian/hexmode" },
	{
		"nathanaelkane/vim-indent-guides",
		init = function()
			vim.g.indent_guides_guide_size = 1
			vim.g.indent_guides_enable_on_vim_startup = 1   -- replaces the VimEnter autocmd
		end,
	},
	{ "godlygeek/tabular" },
	{ "tpope/vim-dispatch" },
	{ "machakann/vim-highlightedyank" },
	{ "editorconfig/editorconfig-vim" },
}
