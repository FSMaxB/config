return {
	{
		"saghen/blink.cmp",
		version = "*", -- tagged release ships the prebuilt fuzzy-matcher binary
		event = "InsertEnter",
		dependencies = { "milanglacier/minuet-ai.nvim" },
		opts = {
			keymap = {
				preset = "enter",
				["<A-y>"] = {
					function(cmp)
						cmp.show({ providers = { "minuet" } })
					end,
				},
			},
			sources = {
				default = { "lsp", "path", "snippets", "buffer", "minuet" },
				providers = {
					minuet = {
						name = "minuet",
						module = "minuet.blink",
						async = true,
						timeout_ms = 3000, -- minuet's request_timeout, in milliseconds
						score_offset = 50,
					},
				},
			},
			-- Prefetching would send a model request on every InsertEnter
			completion = { trigger = { prefetch_on_insert = false } },
		},
		opts_extend = { "sources.default" },
	},
	{
		"milanglacier/minuet-ai.nvim",
		lazy = true,
		opts = {
			provider = "openai_fim_compatible",
			n_completions = 1,
			context_window = 2048,
			request_timeout = 3,
			provider_options = {
				openai_fim_compatible = {
					name = "LM Studio",
					end_point = "http://localhost:1234/v1/completions",
					-- LM Studio ignores the key, but minuet requires the named variable to be set
					api_key = "TERM",
					model = "qwen2.5-coder-7b-instruct-mlx",
					optional = { max_tokens = 64, top_p = 0.9 },
					-- Not every LM Studio engine supports the `suffix` field, so the FIM tokens are spelled out
					template = {
						prompt = function(before, after, _)
							return "<|fim_prefix|>" .. before .. "<|fim_suffix|>" .. after .. "<|fim_middle|>"
						end,
						suffix = false,
					},
				},
			},
		},
	},
}
