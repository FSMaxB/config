vim.keymap.set("", "Y", "y$") -- map Y y$
vim.keymap.set("", ",", "<C-w>") -- comma → window-command prefix
vim.keymap.set("n", ";", ":") -- nnoremap ; :
vim.keymap.set("n", "Ö", ":") -- German-layout colon

-- search for the visual selection with * / # (replaces vim-visualstar)
vim.keymap.set("x", "*", [[y/\V<C-r>=escape(@", '/\')<CR><CR>]])
vim.keymap.set("x", "#", [[y?\V<C-r>=escape(@", '?\')<CR><CR>]])

-- toggle inlay hints (rust-analyzer inline types, etc.) for the current buffer
vim.keymap.set("n", "<leader>uh", function()
	vim.lsp.inlay_hint.enable(not vim.lsp.inlay_hint.is_enabled({ bufnr = 0 }), { bufnr = 0 })
end, { desc = "Toggle inlay hints" })
