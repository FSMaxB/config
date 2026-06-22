return {
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
}
