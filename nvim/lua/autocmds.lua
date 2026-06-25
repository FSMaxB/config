-- briefly highlight yanked text (replaces vim-highlightedyank)
vim.api.nvim_create_autocmd("TextYankPost", {
	callback = function()
		vim.hl.on_yank()
	end,
})

-- enable inlay hints (e.g. rust-analyzer inline type annotations) for any
-- buffer whose attached LSP supports them
vim.api.nvim_create_autocmd("LspAttach", {
	callback = function(args)
		local client = vim.lsp.get_client_by_id(args.data.client_id)
		if client and client:supports_method("textDocument/inlayHint") then
			vim.lsp.inlay_hint.enable(true, { bufnr = args.buf })
		end
	end,
})

-- route LSP progress ($/progress) through the Snacks notifier: a single toast
-- that updates in place with an animated spinner, then a check mark on finish.
vim.api.nvim_create_autocmd("LspProgress", {
	callback = function(ev)
		local spinner = { "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏" }
		vim.notify(vim.lsp.status(), "info", {
			id = "lsp_progress",
			title = "LSP",
			opts = function(notif)
				notif.icon = ev.data.params.value.kind == "end" and " "
					or spinner[math.floor(vim.uv.hrtime() / (1e6 * 80)) % #spinner + 1]
			end,
		})
	end,
})
