return {
	{
		"nvim-lualine/lualine.nvim",
		dependencies = { "nvim-tree/nvim-web-devicons" },
		opts = {
			options = { theme = "gruvbox", globalstatus = true },
		},
	},
	{ "scrooloose/nerdtree" },
	{ "bitc/vim-bad-whitespace" },
	{
		"nathanaelkane/vim-indent-guides",
		init = function()
			vim.g.indent_guides_guide_size = 1
			vim.g.indent_guides_enable_on_vim_startup = 1
		end,
	},
}
