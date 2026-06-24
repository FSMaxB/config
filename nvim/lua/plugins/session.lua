return {
	{
		"folke/persistence.nvim",
		-- Load before the first file is read so the save-on-exit hook is armed.
		event = "BufReadPre",
		opts = {},
		-- LazyVim's session keymaps (manual restore still available alongside auto-restore).
		keys = {
			{ "<leader>qs", function() require("persistence").load() end, desc = "Restore Session" },
			{ "<leader>ql", function() require("persistence").load({ last = true }) end, desc = "Restore Last Session" },
			{ "<leader>qS", function() require("persistence").select() end, desc = "Select Session" },
			{ "<leader>qd", function() require("persistence").stop() end, desc = "Don't Save Current Session" },
		},
		init = function()
			-- Session state to capture (mirrors LazyVim).
			vim.o.sessionoptions = "buffers,curdir,folds,globals,help,skiprtp,tabpages,winsize"

			-- Note if nvim was fed text on stdin, so we don't clobber it with a session.
			vim.api.nvim_create_autocmd("StdinReadPre", {
				callback = function() vim.g.started_with_stdin = true end,
			})

			-- Auto-restore this directory's session, but only for a "bare" launch:
			-- `nvim` with no file arguments and nothing piped in. Opening a specific
			-- file (`nvim foo.rs`) skips restore. `nested` lets the restored buffers
			-- fire their own FileType/syntax autocmds.
			vim.api.nvim_create_autocmd("VimEnter", {
				nested = true,
				callback = function()
					if vim.fn.argc() == 0 and not vim.g.started_with_stdin then
						require("persistence").load()
					end
				end,
			})
		end,
	},
}
