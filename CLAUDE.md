# CLAUDE.md — ai-acct-autopilot

Terminal dashboard + autopilot for multiple Claude Code and Codex accounts.
Zero-dependency Node (>=18), macOS-only (Claude accounts live in the keychain).
Architecture deep-dive: `docs/how-it-works.md`. Read it before non-trivial work.

## Layout

- `bin/ai-acct-autopilot.js` — everything: providers, autopilot, render,
  codex supervisor (`codex-supervise`), subcommands. Single file by design.
- `bin/usage-stats.js` — local-log cost panel (incremental scanner, per-model
  pricing mirrored from CodexBar).
- `bin/claude-acct` — vendored bash account manager for Claude (keychain swap,
  usage, per-worktree pins). The CLI shells out to it; it is load-bearing.

## Commands

- Test: `node bin/ai-acct-autopilot.js --test-decision` (must stay green; add
  a check when you change decision logic, never a tautology).
- Safe manual run: `node bin/ai-acct-autopilot.js --once --no-switch --plain`.
- Anything without `--no-switch` can REALLY switch the user's active accounts.

## Invariants (violating these breaks real overnight workloads)

1. **Never `/logout` / `claude auth logout`** anywhere — it revokes sessions
   server-side. Claude account capture is overwrite-login only.
2. **Never add codex accounts with plain `codex login`** — it revokes the
   previous session. Only `codex-add` (isolated throwaway `CODEX_HOME`).
3. **Never switch into unprobed usage** — targets must pass a live usage probe
   the same tick (both providers).
4. Credential writes are atomic (`tmp` + rename) with `.bak`; failed
   refreshes never delete or overwrite the original blob.
5. The codex shim must stay **fail-open**: any supervisor/ensure failure still
   `exec`s the real codex. The Codex.app app-server is never a kill target.
6. Red in the UI means "needs the user"; amber means "handled"; don't dilute it.
7. Codex switching: only the REGULAR limit bucket (`limit_id: codex`) drives
   decisions; model-family buckets (Spark etc.) are display-ignored.
8. Subcommand blocks run at module top-level — keep shared consts hoisted
   above them (TDZ bit us once) and add new subcommands to the `main()`
   exclusion list.

## Gotchas

- An npm upgrade of `@openai/codex` silently replaces the shim with the stock
  binary (fail-safe direction). `codex-shim install` re-wraps; the installer
  recognizes both current and legacy shim marks.
- Exec-mode codex doesn't hold its rollout file open → sid capture can be
  empty → supervisor relaunches with original args (task re-runs). TUI
  sessions resume properly.
- `claude-acct usage --json` is the Claude usage source AND writes the trend
  history; don't bypass it without preserving history writes.
- Accounts are named by email everywhere. `unsaved-live-*` files are recovery
  blobs claude-acct creates when an unknown live credential is snapshotted.
