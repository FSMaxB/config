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
			{ "<leader>E", "<cmd>Neotree reveal<cr>", desc = "Reveal current file in explorer" },
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
		"lukas-reineke/indent-blankline.nvim",
		main = "ibl",
		event = { "BufReadPre", "BufNewFile" },
		opts = {},
	},
	{
		"folke/trouble.nvim",
		cmd = "Trouble",
		opts = {},
		keys = {
			{ "<leader>xx", "<cmd>Trouble diagnostics toggle<cr>", desc = "Diagnostics (Trouble)" },
			{ "<leader>xX", "<cmd>Trouble diagnostics toggle filter.buf=0<cr>", desc = "Buffer diagnostics (Trouble)" },
			{ "<leader>xs", "<cmd>Trouble symbols toggle<cr>", desc = "Symbols (Trouble)" },
		},
	},
	{
		"nvim-mini/mini.map",
		event = { "BufReadPre", "BufNewFile" },
		config = function()
			local map = require("mini.map")
			map.setup({
				integrations = {
					map.gen_integration.gitsigns(), -- git change markers
					map.gen_integration.diagnostic(), -- error/warn markers
					map.gen_integration.builtin_search(),
				},
				symbols = { encode = map.gen_encode_symbols.dot("4x2") }, -- braille dots
				window = { width = 12, winblend = 25, focusable = true },
			})
			vim.keymap.set("n", "<leader>mm", map.toggle, { desc = "Toggle minimap" })
			vim.keymap.set("n", "<leader>mf", map.toggle_focus, { desc = "Focus minimap" })
			map.open() -- enabled by default
		end,
	},
}
