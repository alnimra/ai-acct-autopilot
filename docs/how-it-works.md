# How it works

This document is the architecture deep-dive: what runs when, where every
credential lives, which endpoints are touched, and why the Codex side needs a
supervisor while the Claude side doesn't.

## The tick (every 60s)

```
tick
 ├─ 1. self-heal Claude tokens
 │     refresh stale NON-active account blobs via OAuth refresh
 │     (atomic tmp+rename, .bak kept, originals never deleted on failure);
 │     re-snapshot the ACTIVE account from the live keychain when its
 │     saved copy goes stale (the live CLI rotates tokens)
 ├─ 2. poll usage
 │     Claude: claude-acct usage --json  (per-account OAuth usage endpoint,
 │             also appends trend history)
 │     Codex:  GET chatgpt.com/backend-api/wham/usage per account token
 │             (works for benched accounts; rollout logs = offline fallback)
 │     also: mirror the active codex account's rotated tokens to its blob
 ├─ 3. autopilot (per provider)
 │     trigger: active account's worst(5h, weekly) ≥ 100 - threshold
 │     target:  healthiest account that PASSED a usage probe this tick
 │     act:     claude-acct use <email>   |   swap ~/.codex/auth.json
 │     then:    (codex) restart supervised sessions so they resume
 │     guards:  cooldown, all-hot hold + single notification, journal
 └─ 4. render
       per-account bars (% left + reset countdowns), trends, cost panel,
       journal tail, per-second countdown footer
```

## Account storage

| Provider | Active credential | Saved accounts |
|---|---|---|
| Claude | macOS keychain item `Claude Code-credentials` | `~/.claude/accounts/<email>.json` (+ `.meta`, `.oauthAccount.json`) |
| Codex | `~/.codex/auth.json` | `~/.codex/accounts/<email>.json` |

Accounts are **named by their email** — unique, profile-verified, and immune
to the stale-nickname drift that plagues hand-named account files.

## Claude token lifecycle

- The **active** account is owned by Claude Code itself: it refreshes tokens
  and writes them to the keychain. The watcher mirrors those rotations into
  the saved blob (`claude-acct save`) so switching away never strands them.
- **Benched** accounts' access tokens expire within hours. The watcher
  refreshes them via Anthropic's OAuth token endpoint using each blob's
  refresh token (the same public client id Claude Code uses). Writes are
  atomic with `.bak`; a refresh that fails with `invalid_grant` marks the
  account "re-auth needed" and never touches the file.
- **Switching** (`claude-acct use`) snapshots the outgoing live keychain blob
  first, then writes the target blob into the keychain and verifies it.
- **Why running Claude sessions survive**: Claude Code re-reads the keychain
  credential (observed ≈30s; also documented by other switchers). Non-pinned
  running sessions just start billing the new account. Worktree pins
  (`CLAUDE_CODE_OAUTH_TOKEN` in `.claude/settings.local.json`) are read at
  process start and never follow the keychain — by design.
- **Never `/logout`**: Claude's logout revokes the session server-side and
  bricks the saved blob. All account capture is overwrite-login.

## Codex: the single-session discovery

Two facts shape the entire Codex design:

1. **A running codex process never re-reads `auth.json`**
   ([openai/codex#17041](https://github.com/openai/codex/issues/17041)).
   Swapping the file only affects *new* processes.
2. **`codex login` in a shared `CODEX_HOME` revokes the session it replaces.**
   Empirically verified: after logging into accounts B, C, D in sequence, only
   D's token still answered the usage endpoint; A–C returned
   `token_revoked`. Crucially, a login in an **isolated** `CODEX_HOME` leaves
   other sessions alive — revocation is login-flow hygiene inside one home,
   not a server-side single-session rule.

Hence:

- **`codex-add <email>`** runs `codex login` in a throwaway isolated
  `CODEX_HOME`, verifies the identity from the id-token JWT, probes its usage,
  and imports `auth.json` into the bench. Existing sessions stay alive.
- **Usage probing** (`GET chatgpt.com/backend-api/wham/usage`, Bearer = the
  account's access token) works for benched accounts with zero sessions and
  zero token burn. Windows nest under `rate_limit`
  (`primary_window` = 5h, `secondary_window` = weekly, `used_percent`,
  `reset_at`); `additional_rate_limits[]` carries model-family buckets
  (e.g. the GPT-5.3-Codex-Spark research preview) which are deliberately
  ignored — only the regular account limit drives display and switching.

## The codex supervisor shim

`codex-shim install` replaces the codex entry point (an npm symlink, e.g.
`/opt/homebrew/bin/codex`) with:

```sh
#!/bin/sh
# ai-acct-autopilot codex shim v3 (node supervisor)
exec node /path/to/ai-acct-autopilot.js codex-supervise -- "$@"
```

`codex-supervise` runs a pre-launch account check (`codex-ensure`: if the
active account has <threshold% left on fresh data and a better bench account
exists, swap `auth.json` *before* codex starts), then spawns the real codex
and waits.

On an account switch, the watcher:

1. finds running codex **launcher** processes (`node …/codex.js`, never the
   Codex.app app-server),
2. reads each session's id from the rollout file its native binary holds open
   (`lsof` on the launcher's descendants),
3. writes the id to `~/.codex/watch-restarts/<pid>` and sends SIGTERM (the
   launcher forwards it to the native binary and mirrors its exit).

The supervisor sees its child die **with a marker** and relaunches:

- original args contained `exec` → `<args up to exec> exec resume <sid>`
- TUI → `<flag args preserved> resume <sid>` (positional prompt dropped — the
  thread already contains it)

Launch flags injected by wrappers (e.g. Superset's `--enable hooks -c
notify=[…]`) survive the resume. No marker → the supervisor mirrors the exit
code/signal exactly like stock codex. TUI exec-mode caveat: exec processes
don't hold their rollout open, so sid capture can come back empty — the
supervisor then relaunches with the original args (the task re-runs).

Fail-safe in both directions: any supervisor/ensure failure still launches
codex, and an npm upgrade of `@openai/codex` simply restores the stock binary
(re-run `codex-shim install` after upgrades).

## Autopilot policy

- **Trigger**: worst of (5h, weekly) utilization ≥ `100 - threshold`
  (default: <5% left). Opus/sonnet sub-windows are display-only.
- **Target ranking**: probe-passing accounts only, lowest worst-window
  utilization wins, soonest 5h reset breaks ties.
- **Guards**: per-provider cooldown (default 10 min); never switch into an
  account that is itself ≥ the threshold; codex never acts on usage data
  older than 30 minutes; "all hot" → hold + one notification with the
  earliest reset.
- **Manual switches are adopted**, never fought: the active account is
  re-detected each tick.

## The menu bar app

`menubar install` compiles `menubar/main.swift` (single file, AppKit only)
with `swiftc` into `~/Applications/AI Acct Autopilot.app` and registers a
LaunchAgent (`com.ai-acct-autopilot.menubar`, RunAtLoad, relaunch on crash
only). The app is deliberately a thin shell — every account, autopilot, and
safety decision stays in the node watcher:

- it spawns `node bin/ai-acct-autopilot.js --menubar` and reads one JSON
  snapshot per tick from stdout (`menubarSnapshot()` — the same data
  `render()` draws, plus an alert list that keeps the red/amber contract);
- manual switches shell back into the canonical paths (`codex-use`,
  `claude-acct use`), then poke the child with **SIGUSR2** for an immediate
  tick (SIGUSR1 is off limits — node reserves it for the inspector);
- the Autopilot menu item restarts the child with/without `--no-switch`;
- absolute node/script/claude-acct paths are baked into the bundle's
  `Resources/config.json` at build time because LaunchAgents start with no
  user PATH. Moving the repo or upgrading node means re-running
  `menubar install`.

If the app dies, the child's stdout pipe breaks and the child exits on its
next write; if the child dies, the app respawns it after 3s.

## The cost panel

`bin/usage-stats.js` streams local session logs —
`~/.claude/projects/**/*.jsonl` (per-message token usage, deduped by
message+request id) and `~/.codex/sessions/**/*.jsonl` (`token_count`
events) — and prices them at public API rates with per-model tables mirrored
from CodexBar (long-context tiers included; the Spark preview is $0). Because
it reads logs rather than account APIs, it aggregates everything the machine
did across every account. Incremental: per-file byte offsets cached in
`~/.cache/ai-acct-autopilot/` (first scan over multi-GB logs takes ~30s,
afterwards ~0.2s). The numbers are estimates at API rates — not your bill.

## Files written

| Path | What |
|---|---|
| `~/.claude/accounts/*.json` (+`.bak`) | Claude account blobs |
| `~/.claude/accounts/switch-journal.jsonl` | append-only event journal (both providers) |
| `~/.claude/accounts/usage-history.json` | Claude usage trend history |
| `~/.codex/accounts/*.json` | Codex account blobs |
| `~/.codex/watch-shim.json` | shim install state (real binary path) |
| `~/.codex/watch-restarts/<pid>` | transient restart markers (sid inside) |
| `~/.cache/ai-acct-autopilot/` | cost-panel incremental scan cache |
| `~/Applications/AI Acct Autopilot.app` | menu bar app bundle (`menubar install`) |
| `~/Library/LaunchAgents/com.ai-acct-autopilot.menubar.plist` | menu bar launch agent |

All credential-bearing files are written `0600`, atomically, with `.bak`
backups. Nothing is ever sent anywhere except the providers' own endpoints.
