return {
	{
		"stevearc/conform.nvim",
		event = { "BufWritePre" },
		cmd = { "ConformInfo", "FormatDisable", "FormatEnable" },
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
			format_on_save = function(bufnr)
				if vim.g.disable_autoformat or vim.b[bufnr].disable_autoformat then
					return
				end
				return { timeout_ms = 1000, lsp_format = "fallback" }
			end,
		},
		config = function(_, opts)
			require("conform").setup(opts)
			vim.api.nvim_create_user_command("FormatDisable", function(args)
				if args.bang then
					-- FormatDisable! will disable formatting just for this buffer
					vim.b.disable_autoformat = true
				else
					vim.g.disable_autoformat = true
				end
			end, { desc = "Disable autoformat-on-save", bang = true })
			vim.api.nvim_create_user_command("FormatEnable", function()
				vim.b.disable_autoformat = false
				vim.g.disable_autoformat = false
			end, { desc = "Re-enable autoformat-on-save" })
		end,
	},
	{
		"WhoIsSethDaniel/mason-tool-installer.nvim",
		dependencies = { "mason-org/mason.nvim" },
		opts = {
			ensure_installed = { "stylua", "prettierd", "shfmt", "taplo", "ruff", "buildifier" },
		},
	},
}
