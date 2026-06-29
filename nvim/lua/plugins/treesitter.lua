return {
	{
		"nvim-treesitter/nvim-treesitter",
		branch = "main",
		lazy = false,
		build = ":TSUpdate",
		dependencies = {
			{ "nvim-treesitter/nvim-treesitter-textobjects", branch = "main" },
		},
		config = function()
			require("nvim-treesitter").install({
				"rust",
				"c",
				"cpp",
				"lua",
				"bash",
				"python",
				"json",
				"yaml",
				"toml",
				"starlark",
				"javascript",
				"typescript",
				"tsx",
				"html",
				"css",
				"markdown",
				"markdown_inline",
				"vim",
				"vimdoc",
				"diff",
				"gitcommit",
				"git_config",
				"query",
			})

			-- start treesitter highlighting for any buffer whose parser is installed
			vim.api.nvim_create_autocmd("FileType", {
				callback = function(ev)
					local lang = vim.treesitter.language.get_lang(vim.bo[ev.buf].filetype)
					if lang then
						pcall(vim.treesitter.start, ev.buf, lang)
					end
				end,
			})

			-- textobjects: af/if (function) and ac/ic (class)
			require("nvim-treesitter-textobjects").setup({ select = { lookahead = true } })
			local select = require("nvim-treesitter-textobjects.select").select_textobject
			local objects =
				{ af = "@function.outer", ["if"] = "@function.inner", ac = "@class.outer", ic = "@class.inner" }
			for lhs, obj in pairs(objects) do
				vim.keymap.set({ "x", "o" }, lhs, function()
					select(obj, "textobjects")
				end, { desc = "TS select " .. obj })
			end
		end,
	},
	{ "windwp/nvim-ts-autotag", event = "VeryLazy", opts = {} },
	{
		"HiPhish/rainbow-delimiters.nvim",
		event = { "BufReadPre", "BufNewFile" },
		config = function()
			local rainbow = require("rainbow-delimiters")
			vim.g.rainbow_delimiters = {
				strategy = { [""] = rainbow.strategy["global"] },
				query = { [""] = "rainbow-delimiters", lua = "rainbow-blocks" },
				highlight = {
					"RainbowDelimiterRed",
					"RainbowDelimiterYellow",
					"RainbowDelimiterBlue",
					"RainbowDelimiterOrange",
					"RainbowDelimiterGreen",
					"RainbowDelimiterViolet",
					"RainbowDelimiterCyan",
				},
			}
		end,
	},
}
