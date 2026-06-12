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
- `menubar/main.swift` — native status-bar app (AppKit, single file). A thin
  shell: it spawns `ai-acct-autopilot.js --menubar` (one JSON snapshot per
  tick on stdout) and shells back into the CLI for actions. ALL decisions
  stay in node; never put switching logic in Swift.
  Refresh poke is SIGUSR2 — SIGUSR1 starts node's inspector.
- `menubar install` prefers `menubar/prebuilt/AIAcctAutopilot` (universal,
  ad-hoc signed, built by `scripts/build-menubar.js` at prepack/CI — npm
  users need no Xcode), falling back to swiftc. The assembled bundle MUST be
  codesign-sealed as the last build step (after config.json) or taskgated
  SIGKILLs it on a fresh CDHash. The prebuilt dir is gitignored but
  force-included in package.json `files`. e2e seams: `AI_ACCT_SWIFTC`,
  `AI_ACCT_MENUBAR_PREBUILT`, `AI_ACCT_MENUBAR_APP`; `codesign` is faked via
  PATH — scenarios must pin `AI_ACCT_MENUBAR_PREBUILT` so a maintainer's
  local prebuilt can't leak into swiftc-path tests. `scripts/build-dmg.js`
  is the maintainer-only signed/notarized DMG (drag-install, no baked
  config — the app runtime-discovers the npm package).

## Commands

- Test: `npm test` = unit (`--test-decision`) + sandboxed e2e (`test/e2e.js`).
  Both must stay green; add a check when you change behavior, never a tautology.
- Coverage gate: `npm run coverage` (c8 via npx, ≥90% lines on `bin/**`).
- Safe manual run: `node bin/ai-acct-autopilot.js --once --no-switch --plain`.
- Anything without `--no-switch` can REALLY switch the user's active accounts.
- The e2e suite runs everything in throwaway `$HOME` sandboxes: fake
  `claude-acct`/`osascript` on PATH, a local TLS mock behind the `AI_ACCT_*`
  URL seams, and fake `ps`/`lsof` (`AI_ACCT_PS_BIN`/`AI_ACCT_LSOF_BIN`) so
  restart logic can NEVER see or signal real codex sessions. Keep it that way:
  a new scenario must not touch real credentials, network, or processes. The
  mock server must stay out-of-process (the suite uses `spawnSync`, which
  blocks the event loop — an in-process mock deadlocks until probe timeouts).

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
