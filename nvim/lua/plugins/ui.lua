return {
	{
		"nvim-lualine/lualine.nvim",
		dependencies = { "nvim-tree/nvim-web-devicons" },
		opts = {
			options = { theme = "gruvbox", globalstatus = true },
		},
	},
	{
		"nvim-neo-tree/neo-tree.nvim",
		branch = "v3.x",
		dependencies = {
			"nvim-lua/plenary.nvim",
			"nvim-tree/nvim-web-devicons",
			"MunifTanjim/nui.nvim",
		},
		keys = {
			{ "<leader>e", "<cmd>Neotree toggle<cr>", desc = "Toggle file explorer" },
		},
		opts = {},
	},
	{
		"echasnovski/mini.trailspace",
		event = { "BufReadPre", "BufNewFile" },
		config = function()
			require("mini.trailspace").setup()
			vim.keymap.set("n", "<leader>cw", function()
				require("mini.trailspace").trim()
			end, { desc = "Trim trailing whitespace" })
		end,
	},
	{
		"nathanaelkane/vim-indent-guides",
		init = function()
			vim.g.indent_guides_guide_size = 1
			vim.g.indent_guides_enable_on_vim_startup = 1
		end,
	},
}
