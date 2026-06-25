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
	{
		"okuuva/auto-save.nvim",
		cmd = "ASToggle",
		event = { "BufReadPre", "BufNewFile" },
		opts = {
			-- only auto-save files that live inside a VCS repo (git or jj).
			-- a plain :write fires conform's format-on-save, so auto-saves format too.
			condition = function(buf)
				if vim.bo[buf].buftype ~= "" then return false end -- skip special buffers
				if vim.api.nvim_buf_get_name(buf) == "" then return false end -- unnamed/scratch
				return vim.fs.root(buf, { ".git", ".jj" }) ~= nil
			end,
			debounce_delay = 1000, -- save 1s after you stop changing (avoids format-on-keystroke)
		},
		keys = {
			{ "<leader>ua", "<cmd>ASToggle<cr>", desc = "Toggle auto-save" },
		},
	},
}
