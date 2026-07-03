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
		-- per-window minimap (mini.map could only attach to the editor edge)
		"Isrothy/neominimap.nvim",
		version = "v3.x.x",
		lazy = false, -- plugin author recommends against lazy-loading
		keys = {
			{ "<leader>mm", "<cmd>Neominimap Toggle<cr>", desc = "Toggle minimap" },
			{ "<leader>mf", "<cmd>Neominimap ToggleFocus<cr>", desc = "Focus minimap" },
		},
		init = function()
			vim.g.neominimap = {
				auto_enable = true,
				layout = "float", -- floats at the right edge of each window
				float = { minimap_width = 12, window_border = "none" },
				diagnostic = { enabled = true, severity = vim.diagnostic.severity.WARN },
				git = { enabled = true },
				search = { enabled = true },
			}
		end,
	},
}
