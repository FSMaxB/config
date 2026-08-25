return {
	{ "tpope/vim-fugitive" },
	{
		"nicolasgb/jj.nvim",
		version = "*",
		dependencies = { "folke/snacks.nvim" },
		config = function()
			require("jj").setup({})

			local picker = require("jj.picker")
			vim.keymap.set("n", "<leader>js", picker.status, { desc = "jj status (picker)" })
			vim.keymap.set("n", "<leader>jh", picker.file_history, { desc = "jj file history (picker)" })
			vim.keymap.set("n", "<leader>jc", picker.conflict, { desc = "jj conflicts (picker)" })
			vim.keymap.set("n", "<leader>jx", picker.conflict_sections, { desc = "jj conflict sections (picker)" })
		end,
	},
	{
		"lewis6991/gitsigns.nvim",
		event = { "BufReadPre", "BufNewFile" },
		opts = {
			current_line_blame = true,
			on_attach = function(buffer)
				local gs = require("gitsigns")
				local function map(lhs, rhs, desc)
					vim.keymap.set("n", lhs, rhs, { buffer = buffer, desc = desc })
				end
				map("]h", function()
					gs.nav_hunk("next")
				end, "Next hunk")
				map("[h", function()
					gs.nav_hunk("prev")
				end, "Prev hunk")
				map("<leader>hs", gs.stage_hunk, "Stage hunk")
				map("<leader>hr", gs.reset_hunk, "Reset hunk")
				map("<leader>hp", gs.preview_hunk, "Preview hunk")
				map("<leader>hb", function()
					gs.blame_line({ full = true })
				end, "Blame line")
			end,
		},
	},
}
