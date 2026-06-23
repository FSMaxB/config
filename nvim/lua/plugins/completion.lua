return {
	{
		"saghen/blink.cmp",
		version = "*", -- tagged release ships the prebuilt fuzzy-matcher binary
		event = "InsertEnter",
		opts = {
			keymap = { preset = "enter" },
			sources = { default = { "lsp", "path", "snippets", "buffer" } },
		},
		opts_extend = { "sources.default" },
	},
}
