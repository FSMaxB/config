return {
	{
		"sudormrfbin/cheatsheet.nvim",
		cmd = { "Cheatsheet", "CheatsheetEdit" },
		keys = {
			{ "<leader>?", "<cmd>Cheatsheet<cr>", desc = "Cheatsheet" },
		},
		-- Telescope is the searchable UI; popup + plenary are its runtime deps.
		dependencies = {
			"nvim-telescope/telescope.nvim",
			"nvim-lua/popup.nvim",
			"nvim-lua/plenary.nvim",
		},
		opts = {
			-- Show only our curated cheatsheet.txt; flip these to true to also get
			-- the plugin's bundled vim/plugin defaults.
			bundled_cheatsheets = false,
			bundled_plugin_cheatsheets = false,
		},
	},
}
