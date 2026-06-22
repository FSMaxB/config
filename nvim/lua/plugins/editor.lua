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
}
