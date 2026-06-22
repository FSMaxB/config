return {
	{
		"neovim/nvim-lspconfig",
		dependencies = {
			{ "mason-org/mason.nvim", opts = {} },
			"mason-org/mason-lspconfig.nvim",
		},
		config = function()
			require("mason-lspconfig").setup({
				-- mason installs these; rust_analyzer + clangd come from the system toolchain.
				ensure_installed = {
					"lua_ls", "bashls", "pyright", "jsonls", "yamlls",
					"taplo", "vtsls", "html", "cssls", "starpls",
				},
				automatic_enable = true,
			})

			-- system binaries already on PATH (toolchain-matched), not installed by mason
			vim.lsp.enable({ "rust_analyzer", "clangd" })

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
