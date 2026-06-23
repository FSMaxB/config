return {
	{
		"stevearc/conform.nvim",
		event = { "BufWritePre" },
		cmd = { "ConformInfo" },
		keys = {
			{
				"<leader>cf",
				function()
					require("conform").format({ async = true })
				end,
				mode = { "n", "x" },
				desc = "Format buffer",
			},
		},
		opts = {
			formatters_by_ft = {
				rust = { "rustfmt" },
				lua = { "stylua" },
				python = { "ruff_format" },
				sh = { "shfmt" },
				toml = { "taplo" },
				bzl = { "buildifier" },
				javascript = { "prettierd" },
				typescript = { "prettierd" },
				json = { "prettierd" },
				yaml = { "prettierd" },
				html = { "prettierd" },
				css = { "prettierd" },
				markdown = { "prettierd" },
			},
			format_on_save = { timeout_ms = 1000, lsp_format = "fallback" },
		},
	},
	{
		"WhoIsSethDaniel/mason-tool-installer.nvim",
		dependencies = { "mason-org/mason.nvim" },
		opts = {
			ensure_installed = { "stylua", "prettierd", "shfmt", "taplo", "ruff", "buildifier" },
		},
	},
}
