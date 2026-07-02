---
name: neovim-dev
description: Develop Neovim plugins and configurations using Lua. Covers vim.api, vim.fn, vim.keymap, autocommands, treesitter, LSP client, extmarks, floating windows, diagnostics, and the Lua-Vimscript bridge. Vimscript only when Lua cannot accomplish the objective, and must be invoked through Lua interfaces.
license: MIT
compatibility: opencode
metadata:
  audience: developers
  domain: neovim-plugin-development
---

## How to Use This Skill

This skill provides principles, patterns, and a curated index of documentation references. The Neovim API is too large to memorize -- use webfetch on the documentation URLs below to look up exact function signatures, parameters, return types, and behavior details when you need specifics.

**Workflow:** Identify which API area you need -> fetch the relevant doc URL -> extract the exact signature/behavior -> implement.

## Core Principles

- **Lua-first**: All plugin and configuration code must be Lua. Vimscript is only acceptable when an objective cannot be accomplished with Lua alone, and even then it must be invoked through Lua interfaces (`vim.cmd()`, `vim.fn[]`). Never write standalone `.vim` files for plugin logic.
- **Target Lua 5.1**: Neovim embeds Lua 5.1. Do not use Lua 5.2+ features (`goto`, `//` integer division, `<const>`). Guard LuaJIT extensions with `if jit then ... else ... end`.
- **Lazy loading**: `plugin/*.lua` runs at startup and must be minimal. Defer `require()` into command/callback/mapping bodies. Do not eagerly require modules at top-level of plugin scripts.
- **No side-effects on require**: Modules return tables of functions/values. Avoid editor operations at require time.
- **Prefer `vim.api` over `vim.fn`**: The Nvim API (`vim.api`) is faster, better typed, and more consistent. Use `vim.fn` only when no equivalent `vim.api` function exists.

## API Layer Model

Neovim exposes three API layers from Lua. Know which layer you're in -- they have different conventions (indexing, argument requirements, error handling).

1. **Vim API** (inherited from Vim): Ex-commands via `vim.cmd()`, Vimscript functions via `vim.fn`. 1-indexed where Vim is 1-indexed. Data is marshalled (copied) across the bridge.
2. **Nvim API** (C-written, RPC-accessible): `vim.api.nvim_*` functions. Mostly 0-indexed, end-exclusive ranges. All arguments must be provided (no defaults from Lua side).
3. **Lua API** (Lua-specific helpers): All other `vim.*` submodules (`vim.keymap`, `vim.fs`, `vim.iter`, `vim.lsp`, `vim.treesitter`, etc.). Lua-native conventions.

## Documentation Reference Index

Fetch these URLs to look up exact signatures, parameters, and behavior.

### Lua Language
- Lua reference (language semantics, standard library): https://neovim.io/doc/user/luaref/
- Lua concepts and idioms (tables, closures, coroutines, error handling, patterns): https://neovim.io/doc/user/lua/#lua-concepts
- Lua guide for Neovim (practical usage of all layers): https://neovim.io/doc/user/lua-guide/

### Core vim Module
- vim module overview (all submodules and utilities): https://neovim.io/doc/user/lua/#lua-vim
- vim.api (Nvim C API -- buffers, windows, tabpages, extmarks, autocommands, commands): https://neovim.io/doc/user/api/#api-global
- vim.fn (Vimscript functions -- use when no vim.api equivalent exists): https://neovim.io/doc/user/lua/#vim.fn
- vim.fn full reference (all functions by category): https://neovim.io/doc/user/vimfn/
- vim.cmd (Ex-command execution, string and table forms): https://neovim.io/doc/user/lua/#vim.cmd()
- vim.keymap (set, del, get mappings): https://neovim.io/doc/user/lua/#vim.keymap
- vim.options (vim.o, vim.opt, vim.opt_local, vim.opt_global, vim.bo, vim.wo, vim.go): https://neovim.io/doc/user/lua/#lua-options
- vim.variables (vim.g, vim.b, vim.w, vim.t, vim.v, vim.env): https://neovim.io/doc/user/lua/#lua-vim-variables
- All editor options: https://neovim.io/doc/user/options/

### Async & Event Loop
- vim.uv (libuv bindings -- timers, fs events, TCP, processes, threads): https://neovim.io/doc/user/lua/#vim.uv
- vim.schedule / vim.defer_fn / vim.schedule_wrap: https://neovim.io/doc/user/lua/#vim.schedule()
- vim.wait (blocking wait with timeout, used for interrupting loops): https://neovim.io/doc/user/lua/#vim.wait()
- luv reference (full libuv API): https://neovim.io/doc/user/luvref/
- Fast events and deferred API calls: https://neovim.io/doc/user/api/#api-fast

### Plugin Development
- Lua plugin development guide (structure, lazy loading, keymaps, config, health, docs, versioning): https://neovim.io/doc/user/lua-plugin/
- Autocommands (nvim_create_autocmd, nvim_create_augroup, nvim_clear_autocmds): https://neovim.io/doc/user/api/#nvim_create_autocmd()
- User commands (nvim_create_user_command, nvim_buf_create_user_command): https://neovim.io/doc/user/api/#nvim_create_user_command()
- Health checks (lua/{plugin}/health.lua): https://neovim.io/doc/user/health/#health-dev

### Buffer & Text Manipulation
- Buffer API (create, get/set lines, attach, marks, extmarks): https://neovim.io/doc/user/api/#api-buffer
- Extmarks guide (position tracking, virtual text, highlighting, signs): https://neovim.io/doc/user/api/#api-extended-marks
- Buffer update events (nvim_buf_attach Lua callbacks): https://neovim.io/doc/user/api/#api-buffer-updates-lua
- Highlighting via extmarks (nvim_buf_set_extmark): https://neovim.io/doc/user/api/#nvim_buf_set_extmark()
- API highlighting groups: https://neovim.io/doc/user/api/#api-highlights

### Windows & UI
- Window API (get/set config, cursor, buffer, position): https://neovim.io/doc/user/api/#api-window
- Floating windows (creation, configuration, border, title, footer): https://neovim.io/doc/user/api/#api-floatwin
- nvim_open_win (create floating/split windows): https://neovim.io/doc/user/api/#nvim_open_win()
- nvim_win_set_config (reconfigure existing windows): https://neovim.io/doc/user/api/#nvim_win_set_config()
- nvim_echo (print chunked, highlighted messages): https://neovim.io/doc/user/api/#nvim_echo()
- vim.notify / vim.notify_once (user notifications, overridable): https://neovim.io/doc/user/lua/#vim.notify()
- vim.ui (select, input -- pluggable UI prompts): https://neovim.io/doc/user/lua/#vim.ui
- vim.ui.open (open URL/file with system handler): https://neovim.io/doc/user/lua/#vim.ui.open()
- vim.ui_attach / vim.ui_detach (subscribe to UI events): https://neovim.io/doc/user/lua/#vim.ui_attach()

### Treesitter
- Treesitter integration overview (parsers, queries, highlighting, injections): https://neovim.io/doc/user/treesitter/
- vim.treesitter module (get_parser, get_node, get_node_text, start/stop, inspect_tree): https://neovim.io/doc/user/treesitter/#lua-treesitter
- TSNode methods (traverse, range, type, children): https://neovim.io/doc/user/treesitter/#treesitter-node
- TSTree methods: https://neovim.io/doc/user/treesitter/#treesitter-tree
- LanguageTree (injected languages, for_each_tree): https://neovim.io/doc/user/treesitter/#treesitter-languagetree
- Query predicates (eq?, match?, contains?, has-parent?, etc.): https://neovim.io/doc/user/treesitter/#treesitter-predicates
- Query directives (set!, offset!, gsub!, trim!): https://neovim.io/doc/user/treesitter/#treesitter-directives
- Language injections (@injection.content, @injection.language): https://neovim.io/doc/user/treesitter/#treesitter-language-injections
- Treesitter highlight groups (@variable, @function, @keyword, etc.): https://neovim.io/doc/user/treesitter/#treesitter-highlight-groups

### LSP Client
- LSP overview (quickstart, defaults, config, FAQ, events): https://neovim.io/doc/user/lsp/
- vim.lsp core (config, enable, start, stop, get_clients, buf_attach_client): https://neovim.io/doc/user/lsp/#lsp-core
- vim.lsp.buf (hover, definition, references, rename, code_action, format, signature_help): https://neovim.io/doc/user/lsp/#lsp-buf
- vim.lsp.Client (methods, capabilities, request, notify, on_attach, is_stopped): https://neovim.io/doc/user/lsp/#vim.lsp.Client
- LSP config system (vim.lsp.config, merging, root_markers, root_dir): https://neovim.io/doc/user/lsp/#lsp-config
- LSP events (LspAttach, LspDetach, LspRequest, LspProgress, LspNotify): https://neovim.io/doc/user/lsp/#lsp-events
- vim.lsp.completion (enable/disable autocompletion): https://neovim.io/doc/user/lsp/#vim.lsp.completion
- vim.lsp.document_color (document color highlighting): https://neovim.io/doc/user/lsp/#vim.lsp.document_color
- vim.lsp.semantic_tokens (semantic highlighting, get_at_pos, highlight_token): https://neovim.io/doc/user/lsp/#vim.lsp.semantic_tokens
- vim.lsp.codelens (codelens refresh, display, run): https://neovim.io/doc/user/lsp/#vim.lsp.codelens
- vim.lsp.inlay_hint (inlay hint enable/disable, refresh): https://neovim.io/doc/user/lsp/#vim.lsp.inlay_hint
- vim.lsp.rpc (RPC client, request, notify, start): https://neovim.io/doc/user/lsp/#vim.lsp.rpc
- vim.lsp.util (apply_workspace_edit, make_floating_popup_size, jump_to_location, etc.): https://neovim.io/doc/user/lsp/#vim.lsp.util
- LSP semantic highlight groups (@lsp.type.*, @lsp.mod.*): https://neovim.io/doc/user/lsp/#lsp-semantic-highlight
- In-process LSP servers (Lua function as cmd): https://neovim.io/doc/user/lsp/#lsp-server

### Diagnostics
- vim.diagnostic (config, get, set, show, hide, goto_next, goto_prev, open_float): https://neovim.io/doc/user/diagnostic/
- Diagnostic highlight groups (DiagnosticWarn, DiagnosticError, DiagnosticInfo, DiagnosticHint, DiagnosticUnderline*): https://neovim.io/doc/user/diagnostic/#diagnostic-highlight

### Highlighting
- vim.hl (on_yank, range, priorities): https://neovim.io/doc/user/lua/#vim.hl
- Highlight groups and syntax: https://neovim.io/doc/user/syntax/#highlight-groups

### Filetype
- vim.filetype (add rules, match files): https://neovim.io/doc/user/lua/#vim.filetype
- Filetype detection: https://neovim.io/doc/user/filetype/

### Utilities
- vim.iter (chainable iterators -- map, filter, fold, find, all, any, tolist): https://neovim.io/doc/user/lua/#vim.iter
- vim.fs (find, normalize, basename, dirname, exists, parents, root): https://neovim.io/doc/user/lua/#vim.fs
- vim.validate (config validation with type checking): https://neovim.io/doc/user/lua/#vim.validate
- vim.inspect (human-readable object representation): https://neovim.io/doc/user/lua/#vim.inspect()
- vim.print / vim.pretty_print (print to message area): https://neovim.io/doc/user/lua/#vim.print()
- vim.tbl_* (table utilities -- deep_extend, isempty, keys, values, filter, map, deepcopy): https://neovim.io/doc/user/lua/#lua-vim
- vim.list_* (list utilities -- slice, extend, remove, sort, uniq): https://neovim.io/doc/user/lua/#lua-vim
- vim.split / vim.gsplit (string splitting with patterns): https://neovim.io/doc/user/lua/#lua-vim
- vim.trim (trim whitespace): https://neovim.io/doc/user/lua/#lua-vim
- vim.regex (Vim regex engine from Lua): https://neovim.io/doc/user/lua/#lua-vim
- vim.pesc (escape magic characters for Lua patterns): https://neovim.io/doc/user/lua/#lua-vim
- vim.stricmp (case-insensitive string comparison): https://neovim.io/doc/user/lua/#vim.stricmp()
- vim.keycode (translate keycodes like <C-o>): https://neovim.io/doc/user/lua/#vim.keycode()
- vim.deprecate (show deprecation warnings): https://neovim.io/doc/user/lua/#vim.deprecate()
- vim.version() (get Neovim version info): https://neovim.io/doc/user/lua/#lua-vim
- vim.mpack (MessagePack encoding/decoding): https://neovim.io/doc/user/lua/#lua-vim
- vim.json (JSON encoding/decoding): https://neovim.io/doc/user/lua/#lua-vim
- vim.text.diff (compute text diffs): https://neovim.io/doc/user/lua/#vim.text.diff
- vim.uri_* (URI/file path conversion utilities): https://neovim.io/doc/user/lua/#lua-vim
- vim.secure (trust management for scripts): https://neovim.io/doc/user/lua/#lua-vim
- vim.snippet (snippet handling): https://neovim.io/doc/user/lua/#vim.snippet
- vim.region (get visual selection region): https://neovim.io/doc/user/lua/#vim.region

### Special Values & Types
- vim.NIL, vim.type_idx, vim.val_idx, vim.types, vim.empty_dict(): https://neovim.io/doc/user/lua/#lua-special-tbl
- Lua-to-Vimscript type conversion rules (list vs dict ambiguity): https://neovim.io/doc/user/lua/#lua-table-ambiguous
- vim.log.levels (DEBUG, ERROR, INFO, TRACE, WARN, OFF): https://neovim.io/doc/user/lua/#vim.log.levels

### Vimscript Bridge
- v:lua interface (calling Lua from Vimscript options): https://neovim.io/doc/user/lua/#v%3Alua-call
- luaeval() (evaluating Lua expressions from Vimscript): https://neovim.io/doc/user/lua/#lua-eval
- lua-heredoc (embedding Lua in Vimscript files): https://neovim.io/doc/user/lua/#%3Alua-heredoc

### API Metadata & Contract
- API metadata discovery (nvim_get_api_info, --api-info): https://neovim.io/doc/user/api/#api-metadata
- API contract (compatibility guarantees, deprecation policy): https://neovim.io/doc/user/api/#api-contract
- API indexing conventions (0-based, end-exclusive, exceptions): https://neovim.io/doc/user/api/#api-definitions

### Channel & RPC
- Channel types (stdio, socket, job, terminal): https://neovim.io/doc/user/channel/
- RPC protocol (msgpack-rpc): https://neovim.io/doc/user/api/#rpc
- vim.rpcnotify / vim.rpcrequest: https://neovim.io/doc/user/lua/#vim.rpcnotify()

## Key Patterns

### Plugin Directory Structure

```
lua/
  myplugin/
    init.lua        -- entry point, returns module table
    config.lua      -- defaults + validation via vim.validate()
    commands.lua    -- user commands (deferred require)
    autocmds.lua    -- autocommands (deferred require)
    health.lua      -- :checkhealth support
```

### Lazy Loading

`plugin/myplugin.lua` defines commands and mappings but defers `require()` into callback bodies. This is the standard pattern -- plugin managers that provide lazy-loading abstractions do the same work under the hood.

### <Plug> Mappings

Expose functionality via `<Plug>(MyPluginAction)` mappings rather than hardcoding user keybindings. Users map `<Plug>` targets to their preferred keys. Detect existing user mappings with `vim.fn.hasmapto()` before setting defaults.

### Autocmd Groups

Always use `nvim_create_augroup()` with `{ clear = true }` to prevent duplicate autocommands on plugin reload. Pass the group ID or name to `nvim_create_autocmd()`.

### Configuration Validation

Validate user config with `vim.validate()`. Check for unknown fields (typos). Consider a `:checkhealth` handler for expensive validation (dependency checks, external tool presence).

### In-Process LSP Servers

Define `cmd` as a Lua function accepting `vim.lsp.rpc.Dispatchers` and returning a `vim.lsp.rpc.Client` table. Useful for plugin-specific UI buffers that need code actions, hover, etc.

## Critical Constraints

- **Indexing**: Most `vim.api` uses 0-based indices, end-exclusive ranges. Exceptions: marks and cursor use 1-based lines/0-based columns. Extmark deletion uses 0-based, end-inclusive.
- **Marshalling**: Lua-to-Vimscript and Vimscript-to-Lua values are COPIED. Modifying a table from `vim.fn` does not affect the original. Setting dictionary fields on `vim.g.foo.field = x` does not work -- read the whole table, modify, write it back.
- **Empty tables**: `{}` converts to a Vimscript list. Use `vim.empty_dict()` for an empty dictionary. Tables with numeric keys 1..N are lists; tables with string keys are dicts.
- **Fast event context**: `vim.uv` callbacks execute in fast event context where `vim.in_fast_event()` is true. Most `vim.api` calls are forbidden (textlock). Use `vim.schedule_wrap()` or `vim.defer_fn()` to schedule editor operations.
- **textlock**: Buffer contents and window layout cannot be modified during certain operations (buf-enter, quickfix, etc.). Schedule if blocked.
- **Ctrl-C interruption**: Lua loops cannot be interrupted by Ctrl-C. Call `vim.wait(0)` periodically in tight loops to yield and check for interruption (returns code -2 on Ctrl-C).
- **kwargs syntax**: Lua allows omitting parentheses when calling a function with a single table literal: `fn { key = val }`. This is syntactic sugar, not true keyword args.
- **Truthiness**: Only `false` and `nil` are falsy in Lua. `0`, `""`, and `{}` are all truthy.
- **Lua patterns ≠ regex**: Lua has its own pattern syntax (limited, no backreferences). Use `vim.regex()` for Vim regex or `vim.re` for PEG grammars when Lua patterns are insufficient.
- **Error handling**: Use `pcall()`/`xpcall()` for catching errors. The idiomatic "result-or-message" pattern returns `nil, "error message"` on expected failures. Use `assert()` to convert result-or-message to an error on failure.
- **API argument strictness**: `vim.api` functions require all arguments. Lua's optional argument convention does not apply -- pass `nil` or `{}` explicitly.
- **Module caching**: `require()` caches results. To reload a module during development: `package.loaded['mymodule'] = nil` then `require('mymodule')`.
- **vim.opt returns Option objects**: `vim.opt.foo` returns an Option object, not the value. Use `vim.opt.foo:get()` to read, or use `vim.o.foo` for direct access.
- **v:lua limitations**: `v:lua` cannot be assigned to variables or passed as callback references in Vimscript. Only direct calls work: `v:lua.func()`.

## When Vimscript Is Necessary

Some operations still require Vimscript. Always invoke through Lua:

- `vim.cmd('...')` or `vim.cmd { cmd = '...', args = {...}, bang = true }` for Ex-commands
- `vim.fn.function_name(...)` for Vimscript functions
- `vim.fn['some#autoload#function'](...)` for autoload functions (bracket notation required for `#`)
- `vim.call('function_name', ...)` as alternative to `vim.fn`
- `v:lua` prefix in Vimscript option strings (e.g., `vim.bo.omnifunc = 'v:lua.mymod.omnifunc'`)

## Type Safety

Use LuaCATS/emmylua annotations with lua-language-server (LuaLS) for static analysis:
- Annotations: https://luals.github.io/wiki/annotations/
- LuaLS: https://luals.github.io/

Neovim's own codebase uses these extensively. Annotate public APIs, config tables, and callback signatures.
