return {
	{
		"neovim/nvim-lspconfig",
		dependencies = {
			{ "mason-org/mason.nvim", opts = {} },
			"mason-org/mason-lspconfig.nvim",
			"saghen/blink.cmp",
		},
		config = function()
			-- advertise blink.cmp's completion capabilities to every server
			vim.lsp.config("*", { capabilities = require("blink.cmp").get_lsp_capabilities() })

			require("mason-lspconfig").setup({
				-- mason installs these; rust_analyzer + clangd come from the system toolchain.
				ensure_installed = {
					"lua_ls", "bashls", "pyright", "jsonls", "yamlls",
					"taplo", "vtsls", "html", "cssls", "starpls",
				},
				-- don't auto-enable every mason package: that also turns formatter tools
				-- with an --lsp mode (stylua, ruff) into redundant LSP clients.
				automatic_enable = false,
			})

			-- enable exactly the servers we want (rust_analyzer + clangd from the system PATH)
			vim.lsp.enable({
				"rust_analyzer", "clangd",
				"lua_ls", "bashls", "pyright", "jsonls", "yamlls",
				"taplo", "vtsls", "html", "cssls", "starpls",
			})

			vim.lsp.config("lua_ls", {
				settings = {
					Lua = {
						workspace = { library = vim.api.nvim_get_runtime_file("", true) },
						diagnostics = { globals = { "vim" } },
					},
				},
			})
			vim.lsp.config("rust_analyzer", {
				settings = { ["rust-analyzer"] = { check = { command = "clippy" } } },
			})

			vim.diagnostic.config({ virtual_text = true, severity_sort = true })
		end,
	},
}
