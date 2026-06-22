-- briefly highlight yanked text (replaces vim-highlightedyank)
vim.api.nvim_create_autocmd("TextYankPost", {
	callback = function()
		vim.hl.on_yank()
	end,
})
