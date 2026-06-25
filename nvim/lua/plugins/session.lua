return {
	{
		"folke/persistence.nvim",
		-- Load before the first file is read so the save-on-exit hook is armed.
		event = "BufReadPre",
		opts = {},
		-- LazyVim's session keymaps. Bare `nvim` opens the Snacks dashboard; restore the
		-- session from there (`s`) or with these maps.
		keys = {
			{
				"<leader>qs",
				function()
					require("persistence").load()
				end,
				desc = "Restore Session",
			},
			{
				"<leader>ql",
				function()
					require("persistence").load({ last = true })
				end,
				desc = "Restore Last Session",
			},
			{
				"<leader>qS",
				function()
					require("persistence").select()
				end,
				desc = "Select Session",
			},
			{
				"<leader>qd",
				function()
					require("persistence").stop()
				end,
				desc = "Don't Save Current Session",
			},
		},
		init = function()
			-- Session state to capture (mirrors LazyVim).
			vim.o.sessionoptions = "buffers,curdir,folds,globals,help,skiprtp,tabpages"
		end,
	},
}
