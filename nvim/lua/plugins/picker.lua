return {
	{
		"folke/snacks.nvim",
		priority = 1000,
		lazy = false,
		opts = {
			picker = { enabled = true },
			bigfile = { enabled = true },
			quickfile = { enabled = true },
		},
		keys = {
			{
				"<leader><space>",
				function()
					Snacks.picker.files()
				end,
				desc = "Find files",
			},
			{
				"<leader>ff",
				function()
					Snacks.picker.files()
				end,
				desc = "Find files",
			},
			{
				"<leader>fg",
				function()
					Snacks.picker.grep()
				end,
				desc = "Grep",
			},
			{
				"<leader>/",
				function()
					Snacks.picker.grep()
				end,
				desc = "Grep",
			},
			{
				"<leader>fb",
				function()
					Snacks.picker.buffers()
				end,
				desc = "Buffers",
			},
			{
				"<leader>fh",
				function()
					Snacks.picker.help()
				end,
				desc = "Help pages",
			},
			{
				"<leader>fd",
				function()
					Snacks.picker.diagnostics()
				end,
				desc = "Diagnostics",
			},
			{
				"<leader>fs",
				function()
					Snacks.picker.lsp_symbols()
				end,
				desc = "LSP symbols",
			},
			{
				"<leader>fr",
				function()
					Snacks.picker.lsp_references()
				end,
				desc = "LSP references",
			},
			{
				"<leader>ft",
				function()
					Snacks.terminal()
				end,
				desc = "Toggle terminal",
			},
			{
				"gd",
				function()
					Snacks.picker.lsp_definitions({ confirm = "tab" })
				end,
				desc = "Goto definition (new tab)",
			},
		},
	},
}
