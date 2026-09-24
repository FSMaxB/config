-- Loaded before init.lua via `--cmd`. lazy.nvim reports spec/config errors
-- through its own error() helper rather than raising, and other plugins
-- (nvim-treesitter's install progress, for one) reassign vim.notify itself
-- during startup, so hooking the global vim.notify is unreliable. Instead,
-- patch lazy's error() the moment its module is first required, the same
-- trick lazy.nvim itself uses on `require` in its bootstrap.
--
-- Once startup finishes, every plugin is force-loaded and `User VeryLazy` is
-- fired by hand, since headless mode never emits UIEnter.

local errors = {}

local orig_require = require
_G.require = function(modname)
	local mod = orig_require(modname)
	if modname == "lazy.core.util" and not mod.__nvim_check_hooked then
		mod.__nvim_check_hooked = true
		local orig_error = mod.error
		mod.error = function(msg, opts)
			table.insert(errors, msg)
			return orig_error(msg, opts)
		end
	end
	return mod
end

local function fail(msg)
	io.stderr:write(msg .. "\n")
	vim.cmd("cquit 1")
end

vim.api.nvim_create_autocmd("VimEnter", {
	once = true,
	callback = function()
		vim.schedule(function()
			local ok, lazy = pcall(require, "lazy")
			if ok then
				for name in pairs(require("lazy.core.config").plugins) do
					pcall(lazy.load, { plugins = { name } })
				end
				pcall(vim.api.nvim_exec_autocmds, "User", { pattern = "VeryLazy" })
			end

			vim.wait(1000)

			if #errors > 0 then
				fail("nvim-check: " .. #errors .. " error(s):\n" .. table.concat(errors, "\n"))
			elseif vim.v.errmsg ~= "" then
				fail("nvim-check: v:errmsg = " .. vim.v.errmsg)
			else
				vim.cmd("qall!")
			end
		end)
	end,
})
