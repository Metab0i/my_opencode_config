---
name: neovim-test
description: Run headless Neovim config tests as the agent user against a config owned by another user. Uses an isolating harness that loads the target config via normal XDG discovery (so `require()` and rtp work) while routing all writable state to a temp HOME, with hard process-exit guarantees (timeout, +qa!, trap, kill). Covers loading checks, keystroke-driven tests, diagnostics/float tests, and arbitrary Lua assertions.
license: MIT
compatibility: opencode
metadata:
  audience: developers
  domain: neovim-config-testing
---

## How to Use This Skill

Use this skill whenever you change Neovim Lua config (yours or another user's) and need to verify it loads and behaves correctly **headlessly, as the agent user** — without manual testing in an interactive session and without writing into the config owner's state/cache dirs.

The harness is `scripts/nvim-test.sh` in this skill directory.

## The Harness

```
~/.config/opencode/skills/neovim-test/scripts/nvim-test.sh
```

### Invocation

```bash
# Inline Lua body (most common — write the test to match whatever you changed):
~/.config/opencode/skills/neovim-test/scripts/nvim-test.sh \
  -c /path/to/config \
  -l 'if vim.o.number then io.stdout:write("TEST_RESULT: PASS\\n"); io.stdout:flush() else io.stdout:write("TEST_RESULT: FAIL: number not set\\n"); io.stdout:flush() end'

# Lua file body instead (use for non-trivial assertions):
... nvim-test.sh -c /path/to/config -f /tmp/my-test.lua

# Verbose (show stdout/stderr on any outcome), custom timeout:
... nvim-test.sh -c /path/to/config -l '...' -v -t 20
```

### What it does

1. **Required `-c CONFIG_DIR`**: the config to test. No default — forces intention and prevents accidental cross-user runs.
2. **Cross-user, read-only config access**: creates a temp HOME, symlinks `TMPHOME/.config/nvim -> CONFIG_DIR`, and launches nvim with `HOME` and `XDG_CONFIG_HOME` pointed at the temp dir. Neovim runs **normal XDG discovery** — so `stdpath("config")` is populated, the runtimepath includes `lua/`, and **`require()` works** (avoiding the `-u <file>` rtp problem). Meanwhile every writable path (`data/`, `state/`, `cache/`, shadafile) resolves under the temp HOME, **owned by the caller** — the config owner's dirs are never modified.
3. **Always-exit guarantee**: `+qa!` as the final nvim arg; wrapped in `timeout --signal=KILL`; a trap on `EXIT/INT/TERM` `kill -KILL`s the recorded PID; and the script ends only after `wait`. A lingering nvim is treated as a failure.

### Test body & result protocol

The Lua you pass via `-l` or `-f` runs **after** the config has loaded (it is a `-c "lua ..."` command). So any `require()` calls inside the user's `init.lua` have already executed — a test can simply assert the resulting state.

The test must print exactly one of these lines to stdout and flush:

```lua
io.stdout:write("TEST_RESULT: PASS\n"); io.stdout:flush()
io.stdout:write("TEST_RESULT: FAIL: <reason>\n"); io.stdout:flush()
```

The harness parses the `TEST_RESULT:` marker for its exit code (0 = PASS). If no marker appears, it reports `FAIL: config load failed: <E-errors>` or `no TEST_RESULT marker emitted` (showing the trimmed nvim stderr). An exit code 137/124 means the timeout killed nvim → `FAIL: nvim did not exit within Ns`.

## Patterns

### Loading smoke test
Assert that the config loaded the state you expected (this body runs *after* `init.lua`, so `require()` calls there already executed). Inline it via `-l` or put it in a temp file passed via `-f`:

```lua
local function pass() io.stdout:write("TEST_RESULT: PASS\n"); io.stdout:flush() end
local function fail(m) io.stdout:write("TEST_RESULT: FAIL: " .. tostring(m) .. "\n"); io.stdout:flush() end

-- Check an option your config sets; replace with whatever your change added:
local ok, m = pcall(require, "your.module")
if not ok then fail("require('your.module') failed: " .. tostring(m)); return end
pass()
```

### Keystroke-driven test (the key lesson from this session)

To test a mapping like `<LocalLeader>p` or `<C-space>`, drive it with typeahead — **not** `vim.fn.getcharstr` loops (which race against typeahead and let keys fall through to normal-mode commands in interactive sessions).

```lua
-- "t" flag = remappable + typed. WITHOUT it, leader-triggered mappings
-- are skipped by feedkeys and the test silently fails to exercise them.
vim.api.nvim_feedkeys("\\p", "t", false)
vim.wait(500, function() return <your expected state predicate> end)
```

For a mapping that itself calls `vim.fn.input()` (prompts on the cmdline and blocks), prime typeahead with the combo **plus a `<CR>`** to submit the prompt, then call the mapping's entry function directly — the `input()` call will consume the primed keys instead of hanging:

```lua
vim.api.nvim_feedkeys("p\r", "t", false)   -- "p" combo, Enter submits the input() prompt
<your-mapping-entry-function>()             -- runs input(), reads primed keys, returns
vim.wait(300, function() return <expected state> end)
```

### Diagnostics / float test
Use a scratch buffer and inject known diagnostics with `vim.diagnostic.set` so you don't depend on an LSP server being attached:

```lua
local buf = vim.api.nvim_create_buf(false, true)
vim.api.nvim_set_current_buf(buf)
vim.diagnostic.set(nil, buf, {
  { lnum = 0, col = 0, message = "fake err", severity = vim.diagnostic.severity.ERROR, source = "test" },
})
-- move cursor onto line 1, call your diagnostics-opening function,
-- then assert a floating window opened (e.g. count windows > 1) or that your
-- graceful branch fired for the "no diagnostics" case.
```

## Authoring tips

- Keep tests **small and single-purpose** — one assertion per file per behavior.
- Use `pcall(require, ...)` and emit `TEST_RESULT: FAIL: <error>` rather than letting a thrown error abort; the harness will report "no marker" which is less informative.
- For timing-sensitive tests, prefer `vim.wait(ms, predicate)` over `vim.defer_fn` + `sleep`; it blocks until the predicate is true (or the ms elapse), then assert the final state.
- Assertions should target the state your change introduced — don't assume specific module names, leader keys, or option values belonging to some particular config; read what the config actually set (`vim.g.mapleader`, `vim.api.nvim_get_keymap("n")`, etc.) and assert against that.

## Headless limitations (assert state, not pixels)

`--headless` nvim has no real terminal UI, so several things are **not reliably observable** headlessly. Trying to read them back produces false negatives or empty data. Do NOT headlessly assert:

- **`virt_lines` / `virt_lines_above` rendering** — there is no API to read them back; they don't occupy the screen grid the way a TUI shows them. (`nvim_buf_get_extmark_by_id` returns position only; `virt_lines`, `hl_group`, `virt_text_pos`, etc. in `opts` are write-only decorations.)
- **Float z-order, border glyphs, `winhighlight`, `winblend` appearance** — the grid the harness sees is not a real composited TUI frame.
- **True cursor glyph / colors / `cursorline` visual blend.**
- **The *visual* effect of scroll commands** (`zt` / `zz` / `zb` / `H` / `L`) — they change the topline, but you can't "see" the viewport; assert the topline instead.

**Assert these (API-level) instead:**

- **Float placement** — `nvim_win_get_config(win).row`, `.col`, `.width`, `.height`, `.relative`. (These are the values you set; they reflect the planned layout precisely.)
- **Viewport position** — `vim.fn.getwininfo(winid)[1].topline` and `.botline` (absolute first/last visible line, 1-based). Use these to decide what the top of the screen shows.
- **Float-ness** — `nvim_win_get_config(win).relative ~= ""` (empty = a normal split window).
- **Extmark *existence*** — `nvim_buf_get_extmark_by_id(buf, ns, id, {details=true})` returns `{row, col}` (and `nil` if deleted); the decoration `opts` are not readable back, so assert the mark exists rather than its visual properties.
- **General buffer/window/option state** — `nvim_buf_get_lines`, `nvim_win_get_cursor`, `nvim_get_option_value`, namespaces via `nvim_get_namespaces`, etc.

**Set headless dimensions in the test body** (`vim.o.lines`, `vim.o.columns`) **before** opening floats — defaults are 24×80, and `vim.o.columns` drives float width math. Self-test:

```lua
vim.o.lines = 30; vim.o.columns = 80
-- open your float, then:
local cfg = vim.api.nvim_win_get_config(win)
assert(cfg.row == 27, "expected bottom dock")   -- asserts planned placement, not pixels
local topline = vim.fn.getwininfo(target)[1].topline
assert(topline == 1, "expected top of file on screen")
```

**Rule of thumb:** assert API state for logic/placement decisions; hand purely-visual behavior (does the highlight *look* right? does the float *visually* sit where the math says?) to the user for interactive verification. Don't burn tokens fighting the headless screen — it will not render `virt_lines` the way a TUI does.

## Editing & improving the harness (verified-edit workflow)

The harness script lives at `scripts/nvim-test.sh`. **Never edit it directly.** Any change to the harness must go through the verified-edit workflow, which proves the change is actually better before it becomes the main harness:

1. **copy** — `nvim-test-verified-edit.sh copy` makes `nvim-test.candidate.sh` from the current main.
2. **edit** — modify only `nvim-test.candidate.sh`.
3. **verify (A/B gate)** — `nvim-test-verified-edit.sh verify --old scripts/nvim-test.sh --new scripts/nvim-test.candidate.sh -c CONFIG -f TEST [-C DIR] [-t SECS] [-v] [--reason "..."]` runs the *same* test (with the *same* forwarded flags) against both old and new harnesses. The candidate is "better" only if it is strictly an improvement:
   - **bug-fix gate:** old harness FAILs the test, candidate harness PASSes it; or
   - **clarity/observability gate:** both PASS, but you supply `--reason "..."` documenting the win (clearer error output, faster, new flag, etc.).
   The verdict, the candidate's **sha256** (`cand_hash`), and the reason are appended to `scripts/nvim-test.verify.log`. Exits 0 if better, 1 otherwise.
4. **promote** — `nvim-test-verified-edit.sh promote` is only allowed if the *latest* verify log block is a BETTER verdict **whose `cand_hash` matches the sha256 of the current candidate file** (so a stale BETTER record can't authorize a different or since-edited candidate), and the candidate differs from main. On promote: the current `nvim-test.sh` is archived as `nvim-test.old.v{N}.sh` (N = max existing version + 1), the candidate becomes `nvim-test.sh`, and both are `chmod +x`. Refuses if candidate == main (no-op) or no matching BETTER verdict is logged.
5. **not better** — discard the candidate (`rm nvim-test.candidate.sh`); the main harness is unchanged.

**Versioning conventions:**

- `nvim-test.sh` is always the latest, authoritative harness.
- `nvim-test.old.v1.sh`, `v2.sh`, … are reverse-chronological generations (v1 = the original, higher N = more recent). Never delete `.old.vN.sh`.
- The helper (`nvim-test-verified-edit.sh`) enforces the gate: `promote` is impossible without a logged verified A/B win, so you can't regress the harness on a hunch.

See `nvim-test-verified-edit.sh status` / `diff` to inspect the main, candidate, latest archive, and last verify result at any time.

## What this skill does NOT do

- It does not run interactive nvim (no TUI). Anything requiring a real terminal UI (visual highlighting, true cursor rendering) is out of scope. See **Headless limitations** above for the full list and the state-assertion alternatives.
- It does not run plugins that need a running job/footer or block on user input indefinitely — those time out and report FAIL. Design the test to exercise the logic without blocking.
- It does not modify or commit the target config. It is read-only with respect to `CONFIG_DIR`.