return {
	{
		"nvim-treesitter/nvim-treesitter",
		build = ":TSUpdate",
		dependencies = { "nvim-treesitter/nvim-treesitter-textobjects" },
		main = "nvim-treesitter.configs",
		opts = {
			ensure_installed = {
				"rust", "c", "cpp", "lua", "bash", "python", "json", "yaml", "toml", "starlark",
				"javascript", "typescript", "tsx", "html", "css", "markdown", "markdown_inline",
				"vim", "vimdoc", "diff", "gitcommit", "git_config", "query",
			},
			highlight = { enable = true },
			indent = { enable = true },
			incremental_selection = { enable = true },
			textobjects = {
				select = {
					enable = true,
					lookahead = true,
					keymaps = {
						["af"] = "@function.outer",
						["if"] = "@function.inner",
						["ac"] = "@class.outer",
						["ic"] = "@class.inner",
					},
				},
			},
		},
	},
	{ "windwp/nvim-ts-autotag", event = "VeryLazy", opts = {} },
}
