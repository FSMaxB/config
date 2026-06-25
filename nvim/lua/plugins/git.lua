return {
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
