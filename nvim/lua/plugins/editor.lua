return {
	{
		"echasnovski/mini.surround",
		event = "VeryLazy",
		config = function()
			-- tpope vim-surround style mappings (ys / ds / cs)
			require("mini.surround").setup({
				mappings = {
					add = "ys",
					delete = "ds",
					replace = "cs",
					find = "",
					find_left = "",
					highlight = "",
					update_n_lines = "",
				},
				search_method = "cover_or_next",
			})
			-- glue for the couple of tpope conveniences mini doesn't map by default
			vim.keymap.set("n", "yss", "ys_", { remap = true })
			vim.keymap.set("x", "S", [[:<C-u>lua MiniSurround.add('visual')<CR>]], { silent = true })
		end,
	},
	{ "tpope/vim-sleuth" },
	{ "windwp/nvim-autopairs", event = "InsertEnter", opts = {} },
	{ "echasnovski/mini.align", event = "VeryLazy", opts = {} },
	{ "folke/which-key.nvim", event = "VeryLazy", opts = {} },
	{
		"folke/flash.nvim",
		event = "VeryLazy",
		opts = {},
		-- s/S only in normal/visual: keeps operator-pending free for the tpope
		-- surround sequences (ds/cs/ys) and visual S for surround.
		keys = {
			{ "s", mode = { "n", "x" }, function() require("flash").jump() end, desc = "Flash jump" },
			{ "S", mode = "n", function() require("flash").treesitter() end, desc = "Flash Treesitter" },
		},
	},
}
