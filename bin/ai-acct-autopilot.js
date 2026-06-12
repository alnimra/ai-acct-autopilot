#!/usr/bin/env node
// ai-acct-autopilot — terminal dashboard + autopilot for multiple AI CLI accounts.
//
//   Providers:
//     • Claude (claude-acct accounts, macOS keychain) — auto-switch moves
//       RUNNING non-pinned sessions too (they re-read the keychain in ~30s).
//     • Codex (ChatGPT, ~/.codex/auth.json) — auto-switch applies to NEW or
//       restarted codex sessions only: a live codex process holds auth in
//       memory and never re-reads auth.json (openai/codex#17041).
//
//   Every tick (default 60s), per provider:
//     1. self-heal tokens (Claude: OAuth-refresh stale non-active blobs,
//        atomic + .bak; re-snapshot the active account from the keychain).
//     2. poll usage (Claude: claude-acct usage --json; Codex: latest
//        rate_limits event in ~/.codex/sessions rollout logs — passive, no
//        API calls; primary=5h, secondary=weekly).
//     3. render codexbar-style bars: "N% left", reset countdowns, trends.
//     4. autopilot: active account < threshold % left on 5h or weekly →
//        switch to the healthiest saved account.
//
//   ai-acct-autopilot [--interval 60] [--threshold 5] [--cooldown 10]
//                [--once] [--no-switch] [--plain] [--menubar]
//   ai-acct-autopilot codex-save           snapshot current codex account
//   ai-acct-autopilot codex-use <email>    switch codex account (new sessions)
//   ai-acct-autopilot codex-list           list saved codex accounts
//   ai-acct-autopilot menubar install      native macOS menu bar app (CodexBar-style)
//
// Accounts are named by their email (unique, profile-verified).
// Zero dependencies. NEVER logs token material.

'use strict';
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const HOME = os.homedir();
const DIR = path.join(HOME, '.claude', 'accounts');
const JOURNAL = path.join(DIR, 'switch-journal.jsonl');
const HISTORY = path.join(DIR, 'usage-history.json');
const CLAUDE_JSON = path.join(HOME, '.claude.json');
const CODEX_AUTH = path.join(HOME, '.codex', 'auth.json');
const CODEX_DIR = path.join(HOME, '.codex', 'accounts');
const CODEX_SESSIONS = path.join(HOME, '.codex', 'sessions');
const usageStats = require('./usage-stats'); // local-log cost/token stats (account-independent)
// Claude Code CLI's public OAuth client — same client the CLI itself uses.
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
// AI_ACCT_* overrides exist for non-standard installs and the sandboxed e2e
// suite (test/e2e.js); production behavior is the default on every one.
const OAUTH_TOKEN_URL = process.env.AI_ACCT_OAUTH_URL || 'https://console.anthropic.com/v1/oauth/token';
const WHAM_USAGE_URL = process.env.AI_ACCT_WHAM_URL || 'https://chatgpt.com/backend-api/wham/usage';
const PS_BIN = process.env.AI_ACCT_PS_BIN || '/bin/ps';
const LSOF_BIN = process.env.AI_ACCT_LSOF_BIN || '/usr/sbin/lsof';
const CODEX_BIN_OVERRIDE = process.env.AI_ACCT_CODEX_BIN || null;
const CODEX_USAGE_MAX_AGE_MS = 30 * 60_000;  // stale usage never drives a switch
// shim constants live up here: subcommand blocks run at module top-level and
// call into shim helpers before later const declarations would initialize (TDZ)
const SHIM_MARK = '# ai-acct-autopilot codex shim';
const SHIM_MARK_LEGACY = '# ai-cli-watch codex shim'; // pre-rename installs upgrade in place
const SHIM_STATE = path.join(HOME, '.codex', 'watch-shim.json');
const RESTART_DIR = path.join(HOME, '.codex', 'watch-restarts');
// menubar app constants (AI_ACCT_* overrides = e2e sandbox seams, same as above)
const MENUBAR_LABEL = 'com.ai-acct-autopilot.menubar';
const MENUBAR_APP = process.env.AI_ACCT_MENUBAR_APP || path.join(HOME, 'Applications', 'AI Acct Autopilot.app');
const MENUBAR_AGENT = path.join(HOME, 'Library', 'LaunchAgents', `${MENUBAR_LABEL}.plist`);
const MENUBAR_SRC = path.join(__dirname, '..', 'menubar', 'main.swift');
const SWIFTC_OVERRIDE = process.env.AI_ACCT_SWIFTC || null; // null → xcrun -sdk macosx swiftc
// npm tarballs ship a prebuilt universal binary (scripts/build-menubar.js,
// prepack) so users never need Xcode; git clones fall back to swiftc.
const MENUBAR_PREBUILT = process.env.AI_ACCT_MENUBAR_PREBUILT
  || path.join(__dirname, '..', 'menubar', 'prebuilt', 'AIAcctAutopilot');

const acctBin = fs.existsSync(path.join(HOME, '.local', 'bin', 'claude-acct'))
  ? path.join(HOME, '.local', 'bin', 'claude-acct') : 'claude-acct';

// ---------- args ----------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  if (i === -1 || i + 1 >= argv.length) return dflt;
  const n = Number(argv[i + 1]);
  return Number.isFinite(n) ? n : dflt;
};
if (flag('--help') || flag('-h')) {
  console.log(`ai-acct-autopilot — usage dashboard + auto-switch for Claude & Codex accounts

  --interval N   seconds between checks (default 60)
  --threshold N  auto-switch when active account has < N% left (default 5)
  --cooldown N   minutes between auto-switches per provider (default 10)
  --once         one tick, then exit
  --no-switch    monitor only — never switch accounts
  --plain        no screen clearing / colors (logging mode)
  --menubar      emit one JSON status line per tick (the menu bar app's feed)

  codex-add <email?>     log a NEW codex account into the bench (isolated login —
                         the current session stays alive)
  codex-save             snapshot the current codex account (~/.codex/accounts)
  codex-use <email>      switch codex account — applies to NEW sessions only
  codex-list             list saved codex accounts
  menubar <sub>          native macOS menu bar app (CodexBar-style):
                         install | build | start | stop | status | uninstall
                         (npm installs use the bundled prebuilt binary — no
                         Xcode; pass --from-source to force a swiftc build)

Claude accounts are managed with claude-acct (add/save/use by email).`);
  process.exit(0);
}
const INTERVAL = Math.max(15, opt('--interval', 60));
const THRESHOLD = Math.min(50, Math.max(1, opt('--threshold', 5)));
const COOLDOWN_MS = Math.max(1, opt('--cooldown', 10)) * 60_000;
const ONCE = flag('--once');
const NO_SWITCH = flag('--no-switch');
// menubar mode: the Swift status-bar app spawns this process and reads one
// JSON snapshot line per tick from stdout — no ANSI, ever, on that stream.
const MENUBAR = flag('--menubar');
// AI_ACCT_FORCE_ANSI: e2e seam — exercise the interactive render path against
// a pipe (no pty on macOS CI). Never set in production.
const PLAIN = flag('--plain') || MENUBAR || (!process.stdout.isTTY && !process.env.AI_ACCT_FORCE_ANSI);

// ---------- ansi ----------
const ansi = !PLAIN;
const esc = (s) => (ansi ? s : '');
const rgb = (r, g, b) => esc(`\x1b[38;2;${r};${g};${b}m`);
const C = {
  reset: esc('\x1b[0m'), bold: esc('\x1b[1m'), dim: esc('\x1b[2m'),
  tan: rgb(232, 160, 76),        // codexbar warm bar
  blue: rgb(96, 165, 250),       // codex accent (codexbar's codex view)
  orange: rgb(249, 117, 78),     // parker orange
  amber: rgb(249, 191, 1),
  red: rgb(233, 59, 35),
  green: rgb(82, 178, 138),
  grey: rgb(151, 150, 146),
  grey2: rgb(99, 98, 94),
  white: rgb(251, 251, 247),
};
const stripLen = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;

// ---------- small utils ----------
const run = (cmd, args, timeout = 90_000) => new Promise((resolve) => {
  execFile(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 },
    (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' }));
});
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null);
const now = () => Date.now();

function atomicWrite(file, content) {
  if (fs.existsSync(file)) { try { fs.copyFileSync(file, `${file}.bak`); } catch {} }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function rel(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  let s = Math.round((t - now()) / 1000);
  const past = s < 0; s = Math.abs(s);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  const txt = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
  return past ? `${txt} ago` : `in ${txt}`;
}

function notify(title, body) {
  if (process.platform !== 'darwin') return;
  const q = (s) => String(s).replace(/[\\"]/g, '');
  execFile('osascript', ['-e', `display notification "${q(body)}" with title "${q(title)}" sound name "Glass"`], () => {});
}

function journalAppend(evt) {
  try { fs.appendFileSync(JOURNAL, JSON.stringify({ ts: new Date().toISOString(), ...evt }) + '\n', { mode: 0o600 }); } catch {}
}
function journalTail(n, filter) {
  try {
    const lines = fs.readFileSync(JOURNAL, 'utf8').trim().split('\n');
    const evts = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return (filter ? evts.filter(filter) : evts).slice(-n);
  } catch { return []; }
}
function lastSwitchTs(provider) {
  const evts = journalTail(100, (e) => e.event === 'switch' && (e.provider || 'claude') === provider);
  return evts.length ? new Date(evts[evts.length - 1].ts).getTime() : 0;
}

// ════════════════════════ CLAUDE provider ════════════════════════
function accountNames() {
  let files = [];
  try { files = fs.readdirSync(DIR); } catch {}
  return files.filter((f) => f.endsWith('.json') && !f.startsWith('.')
    && f !== 'usage-history.json' && !f.endsWith('.oauthAccount.json'))
    .map((f) => f.slice(0, -5));
}
const isRecovery = (name) => name.startsWith('unsaved-live-');

function liveEmail() {
  const cfg = readJson(CLAUDE_JSON);
  return cfg && cfg.oauthAccount && cfg.oauthAccount.emailAddress || null;
}
function emailOf(name) {
  const meta = path.join(DIR, `${name}.meta`);
  try {
    const m = fs.readFileSync(meta, 'utf8').match(/^email=(.+)$/m);
    if (m) return m[1];
  } catch {}
  const oauth = readJson(path.join(DIR, `${name}.oauthAccount.json`));
  return oauth && oauth.emailAddress || null;
}

function oauthRefresh(refreshToken) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: OAUTH_CLIENT_ID });
    const req = https.request(OAUTH_TOKEN_URL, {
      method: 'POST', timeout: 20_000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        let data = null; try { data = JSON.parse(b); } catch {}
        resolve({ ok: res.statusCode === 200 && data && data.access_token, status: res.statusCode, data });
      });
    });
    req.on('error', () => resolve({ ok: false, status: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0 }); });
    req.end(body);
  });
}

// Refresh a saved NON-active account blob in place. Atomic: tmp+rename, .bak of
// the previous valid blob. On any failure the original file is untouched.
async function refreshBlob(name, state) {
  const file = path.join(DIR, `${name}.json`);
  const blob = readJson(file);
  const oauth = blob && blob.claudeAiOauth;
  if (!oauth || !oauth.refreshToken) { state.reauth.add(name); return false; }
  const r = await oauthRefresh(oauth.refreshToken);
  if (!r.ok) {
    if (r.status === 400 || r.status === 401 || r.status === 403) state.reauth.add(name);
    return false; // keep old blob — refresh may be transient (network)
  }
  const next = { ...blob, claudeAiOauth: { ...oauth,
    accessToken: r.data.access_token,
    refreshToken: r.data.refresh_token || oauth.refreshToken,
    expiresAt: now() + (Number(r.data.expires_in) || 3600) * 1000,
  } };
  try {
    atomicWrite(file, JSON.stringify(next));
    state.reauth.delete(name);
    return true;
  } catch { return false; }
}

function tokenStale(name) {
  const blob = readJson(path.join(DIR, `${name}.json`));
  const oauth = blob && blob.claudeAiOauth;
  if (!oauth || !oauth.accessToken) return true;
  return !oauth.expiresAt || now() > oauth.expiresAt - 120_000;
}

async function fetchUsage() {
  const r = await run(acctBin, ['usage', '--json'], 120_000);
  if (!r.ok) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

// seven_day_sonnet exists in the API response too (only for accounts with an
// active sonnet window) but is deliberately NOT displayed — model sub-windows
// other than opus are noise, and none of them ever drive switching.
const WINDOWS = [
  ['5h', 'five_hour'], ['weekly', 'seven_day'], ['opus', 'seven_day_opus'],
];

function rowsFor(result) {
  if (!result.usage || !result.usage.ok) return null;
  const d = result.usage.data || {};
  const rows = [];
  for (const [label, key] of WINDOWS) {
    const w = d[key];
    if (!w) continue;
    const used = pct(w.utilization);
    const optional = key === 'seven_day_opus';
    if (optional && !w.resets_at && (used === null || used === 0)) continue;
    rows.push({ label, key, used, resetsAt: w.resets_at || null });
  }
  return rows;
}

function trendFor(keyName) {
  const hist = readJson(HISTORY);
  const entries = hist && hist.accounts && hist.accounts[keyName] && hist.accounts[keyName].five_hour || [];
  return sparkline(entries.slice(-28).map((e) => pct(e.usedPercent) ?? 0));
}
function sparkline(values) {
  const blocks = '▁▂▃▄▅▆▇█';
  return values.map((u) => blocks[Math.max(0, Math.min(7, Math.round((u / 100) * 7)))]).join('');
}

function worstUsed(rows) { // decision windows only: 5h + weekly
  let worst = null;
  for (const r of rows || []) {
    if (r.key !== 'five_hour' && r.key !== 'seven_day') continue;
    if (r.used === null) continue;
    if (worst === null || r.used > worst) worst = r.used;
  }
  return worst;
}

function pickTarget(report, activeName) {
  const candidates = [];
  for (const res of report.results) {
    if (res.account === activeName || isRecovery(res.account)) continue;
    const rows = rowsFor(res);
    if (!rows) continue;                      // unknown usage → never a target
    const worst = worstUsed(rows);
    if (worst === null || worst >= 100 - THRESHOLD) continue; // also nearly dead
    const fiveReset = (rows.find((r) => r.key === 'five_hour') || {}).resetsAt || '9999';
    candidates.push({ name: res.account, worst, fiveReset });
  }
  candidates.sort((a, b) => a.worst - b.worst || String(a.fiveReset).localeCompare(String(b.fiveReset)));
  return candidates[0] || null;
}

async function claudeAutopilot(report, state) {
  const activeName = report.active;
  if (!activeName) return;
  const active = report.results.find((r) => r.account === activeName);
  const rows = active && rowsFor(active);
  if (!rows) return;                          // active usage unknown → handled by self-heal
  const worst = worstUsed(rows);
  if (worst === null || worst < 100 - THRESHOLD) { state.allHotNotified = false; state.holdReason = null; return; }

  const target = pickTarget(report, activeName);
  if (!target) {
    state.holdReason = 'claude: all accounts hot or unavailable — holding';
    if (!state.allHotNotified) {
      notify('ai-acct-autopilot', 'All Claude accounts near their limits — nothing to switch to.');
      journalAppend({ provider: 'claude', event: 'all-hot', active: activeName, worst });
      state.allHotNotified = true;
    }
    return;
  }
  if (NO_SWITCH) {
    state.holdReason = `claude: monitor-only — WOULD switch ${activeName} → ${target.name} (${Math.round(100 - worst)}% left)`;
    return;
  }
  if (now() - lastSwitchTs('claude') < COOLDOWN_MS) {
    state.holdReason = `claude: cooldown — would switch to ${target.name}`;
    return;
  }
  state.holdReason = null;
  const r = await run(acctBin, ['use', target.name], 60_000);
  if (r.ok) {
    journalAppend({ provider: 'claude', event: 'switch', from: activeName, to: target.name, reason: `${activeName} ${Math.round(100 - worst)}% left`, targetWorst: target.worst });
    notify('ai-acct-autopilot: Claude switched', `${activeName} → ${target.name} (${activeName} had ${Math.round(100 - worst)}% left)`);
    state.justSwitched = `claude ${activeName} → ${target.name}`;
  } else {
    journalAppend({ provider: 'claude', event: 'switch-failed', from: activeName, to: target.name });
    notify('ai-acct-autopilot: Claude switch FAILED', `${activeName} → ${target.name} — check terminal`);
  }
}

// Self-heal the ACTIVE claude account: its saved blob goes stale because the
// live keychain (Claude CLI) rotates tokens. Re-snapshot via claude-acct save.
async function healActive(report, state) {
  const activeName = report.active;
  if (!activeName) return false;
  const active = report.results.find((r) => r.account === activeName);
  if (!active || (active.usage && active.usage.ok)) return false;
  if (state.lastHealTry && now() - state.lastHealTry < 5 * 60_000) return false;
  state.lastHealTry = now();
  const email = liveEmail();
  // Save under the matching saved account, else under the live email itself —
  // emails are the canonical account names, so no more unsaved-live-* blobs.
  const match = accountNames().find((n) => n === email || (emailOf(n) && emailOf(n) === email))
    || email || activeName;
  const r = await run(acctBin, ['save', match], 30_000);
  if (r.ok) journalAppend({ provider: 'claude', event: 'snapshot', account: match });
  return r.ok;
}

// Persist profile-verified emails so future refresh targeting and active
// matching work for accounts saved before claude-acct wrote .meta files.
function persistEmails(report) {
  for (const res of report.results || []) {
    if (!res.email || emailOf(res.account)) continue;
    try { fs.writeFileSync(path.join(DIR, `${res.account}.meta`), `email=${res.email}\n`, { mode: 0o600 }); } catch {}
  }
}

// ════════════════════════ CODEX provider ════════════════════════
function codexJwtClaims(blob) {
  try {
    const idt = blob && blob.tokens && blob.tokens.id_token;
    if (!idt) return null;
    return JSON.parse(Buffer.from(idt.split('.')[1], 'base64url').toString());
  } catch { return null; }
}
function codexIdentity(blob) {
  const claims = codexJwtClaims(blob);
  if (!claims) return null;
  const auth = claims['https://api.openai.com/auth'] || {};
  return { email: claims.email || null, plan: auth.chatgpt_plan_type || null };
}
function codexSavedAccounts() {
  let files = [];
  try { files = fs.readdirSync(CODEX_DIR); } catch {}
  return files.filter((f) => f.endsWith('.json') && !f.startsWith('.')).map((f) => f.slice(0, -5));
}

// Direct per-account usage probe (CodexBar's OAuth path): GET wham/usage with
// the account's access token. Works for BENCHED accounts too — no session, no
// token burn. 401 token_revoked = that account needs a fresh `codex login`
// (codex sessions are single-active: each login revokes the previous one).
function codexProbeUsage(token) {
  return new Promise((resolve) => {
    if (!token) { resolve({ ok: false, status: 0 }); return; }
    https.get(WHAM_USAGE_URL, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, timeout: 15_000,
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        let body = null; try { body = JSON.parse(b); } catch {}
        if (res.statusCode !== 200 || !body) { resolve({ ok: false, status: res.statusCode, code: body && body.error && body.error.code }); return; }
        resolve({ ok: true, status: 200, ...mapWham(body) });
      });
    }).on('error', () => resolve({ ok: false, status: 0 }))
      .on('timeout', function () { this.destroy(); });
  });
}
function mapWham(body) {
  const rl = body.rate_limit || body;   // windows nest under rate_limit; Spark etc. live in additional_rate_limits (ignored)
  const toIso = (u) => (u ? new Date(u * 1000).toISOString() : null);
  const win = (w, label, key) => (w ? { label, key, used: pct(w.used_percent), resetsAt: toIso(w.reset_at) } : null);
  const rows = [
    win(rl.primary_window, '5h', 'five_hour'),
    win(rl.secondary_window, 'weekly', 'seven_day'),
  ].filter(Boolean);
  return { rows, worst: worstUsed(rows), email: body.email || null, plan: body.plan_type || null };
}

// Probe active + all saved codex accounts once per tick: email -> probe result.
async function codexProbeAll() {
  const probes = new Map();
  const activeBlob = readJson(CODEX_AUTH);
  const activeId = codexIdentity(activeBlob);
  if (activeId && activeId.email) {
    probes.set(activeId.email, await codexProbeUsage(activeBlob.tokens && activeBlob.tokens.access_token));
  }
  for (const email of codexSavedAccounts()) {
    if (probes.has(email)) continue;
    const blob = readJson(path.join(CODEX_DIR, `${email}.json`));
    probes.set(email, await codexProbeUsage(blob && blob.tokens && blob.tokens.access_token));
  }
  return probes;
}

function codexSnapshotActive() {
  const blob = readJson(CODEX_AUTH);
  const id = codexIdentity(blob);
  if (!blob || !id || !id.email) return null;
  fs.mkdirSync(CODEX_DIR, { recursive: true, mode: 0o700 });
  // record last-known usage at bench time so target ranking has a hint
  const usage = codexUsage();
  const meta = usage && usage.fresh ? { worst: usage.worst, ts: new Date().toISOString() } : (blob._watchMeta || null);
  atomicWrite(path.join(CODEX_DIR, `${id.email}.json`), JSON.stringify({ ...blob, _watchMeta: meta }));
  return id.email;
}

function codexUse(email) {
  const file = path.join(CODEX_DIR, `${email}.json`);
  const target = readJson(file);
  if (!target || !target.tokens || !target.tokens.refresh_token) return { ok: false, error: `no usable saved codex account "${email}"` };
  codexSnapshotActive();
  const { _watchMeta, ...clean } = target;
  try { atomicWrite(CODEX_AUTH, JSON.stringify(clean, null, 2)); } catch (e) { return { ok: false, error: String(e.message || e) }; }
  return { ok: true };
}

// Latest rate_limits event from codex rollout logs (passive; no API calls).
// primary = 5h window, secondary = weekly. Newest few files, tail-read only.
function codexRolloutFiles(maxAgeDays = 3) {
  const out = [];
  const cutoff = now() - maxAgeDays * 86400_000;
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        let st; try { st = fs.statSync(p); } catch { continue; }
        if (st.mtimeMs >= cutoff) out.push({ p, mtime: st.mtimeMs });
      }
    }
  };
  walk(CODEX_SESSIONS, 0);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, 4);
}

function tailLines(file, bytes = 512 * 1024) {
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    if (size > len) lines.shift(); // drop partial first line
    return lines;
  } catch { return []; }
}

// Codex reports SEPARATE limit buckets per model family (e.g. limit_id
// "codex" = the regular account limit, "codex_bengalfox" = GPT-5.3-Codex-Spark).
// Only the REGULAR bucket drives display + switching: prefer limit_id "codex",
// else the bucket without a special limit_name, else the freshest.
function chooseBucket(buckets) {
  const keys = Object.keys(buckets);
  if (!keys.length) return null;
  if (buckets.codex) return buckets.codex;
  const unnamed = keys.filter((k) => !(buckets[k].rl && buckets[k].rl.limit_name));
  const pool = unnamed.length ? unnamed : keys;
  return pool.map((k) => buckets[k]).sort((a, b) => b.ts - a.ts)[0];
}

let codexUsageCache = null; // per-tick cache
function codexUsage() {
  if (codexUsageCache && now() - codexUsageCache.at < 30_000) return codexUsageCache.value;
  const buckets = {}; // limit_id -> { ts, rl, samples: [{ts, used}] }
  for (const f of codexRolloutFiles()) {
    for (const line of tailLines(f.p)) {
      let j; try { j = JSON.parse(line); } catch { continue; }
      const rl = (j.payload && j.payload.rate_limits)
        || (j.payload && j.payload.info && j.payload.info.rate_limits) || j.rate_limits;
      if (!rl || !rl.primary) continue;
      const ts = new Date(j.timestamp || 0).getTime();
      const id = rl.limit_id || '(none)';
      buckets[id] ||= { ts: 0, rl: null, samples: [] };
      buckets[id].samples.push({ ts, used: pct(rl.primary.used_percent) ?? 0 });
      if (ts > buckets[id].ts) { buckets[id].ts = ts; buckets[id].rl = rl; }
    }
  }
  const chosen = chooseBucket(buckets);
  let value = null;
  if (chosen) {
    const toIso = (u) => (u ? new Date(u * 1000).toISOString() : null);
    const rows = [
      { label: '5h', key: 'five_hour', used: pct(chosen.rl.primary.used_percent), resetsAt: toIso(chosen.rl.primary.resets_at) },
      chosen.rl.secondary ? { label: 'weekly', key: 'seven_day', used: pct(chosen.rl.secondary.used_percent), resetsAt: toIso(chosen.rl.secondary.resets_at) } : null,
    ].filter(Boolean);
    chosen.samples.sort((a, b) => a.ts - b.ts);
    value = {
      rows, ts: chosen.ts,
      fresh: now() - chosen.ts < CODEX_USAGE_MAX_AGE_MS,
      worst: worstUsed(rows),
      limitName: chosen.rl.limit_name || null, // null for the regular bucket
      plan: chosen.rl.plan_type || null,
      trend: sparkline(dedupeAdjacent(chosen.samples.map((s) => s.used)).slice(-28)),
    };
  }
  codexUsageCache = { at: now(), value };
  return value;
}
function dedupeAdjacent(arr) { return arr.filter((v, i) => i === 0 || v !== arr[i - 1]); }

function codexPickTarget(activeEmail, probes) {
  const candidates = [];
  for (const email of codexSavedAccounts()) {
    if (email === activeEmail) continue;
    const p = probes && probes.get(email);
    if (!p || !p.ok || p.worst === null) continue;           // unknown usage → never a target
    if (p.worst >= 100 - THRESHOLD) continue;                // nearly dead too
    candidates.push({ name: email, worst: p.worst });
  }
  candidates.sort((a, b) => a.worst - b.worst);
  return candidates[0] || null;
}

async function codexAutopilot(state) {
  const blob = readJson(CODEX_AUTH);
  const id = codexIdentity(blob);
  if (!id || !id.email) return;
  const probes = state.codexProbes || new Map();
  const active = probes.get(id.email);
  // prefer the live probe (always fresh); fall back to rollout logs offline
  let worst = active && active.ok ? active.worst : null;
  if (worst === null) {
    const usage = codexUsage();
    if (!usage || !usage.fresh || usage.ts < lastSwitchTs('codex')) return;
    worst = usage.worst;
  }
  if (worst === null || worst < 100 - THRESHOLD) { state.codexAllHot = false; state.codexHold = null; return; }
  const usage = { worst };

  const target = codexPickTarget(id.email, probes);
  if (!target) {
    state.codexHold = codexSavedAccounts().filter((e) => e !== id.email).length
      ? 'codex: all saved accounts look hot — holding'
      : 'codex: no other saved account — run codex-save on a second account to enable switching';
    if (!state.codexAllHot && codexSavedAccounts().length > 1) {
      notify('ai-acct-autopilot', 'Codex account near its limits — no usable fallback saved.');
      journalAppend({ provider: 'codex', event: 'all-hot', active: id.email, worst: usage.worst });
      state.codexAllHot = true;
    }
    return;
  }
  if (NO_SWITCH) {
    state.codexHold = `codex: monitor-only — WOULD switch ${id.email} → ${target.name} (${Math.round(100 - usage.worst)}% left)`;
    return;
  }
  if (now() - lastSwitchTs('codex') < COOLDOWN_MS) {
    state.codexHold = `codex: cooldown — would switch to ${target.name}`;
    return;
  }
  state.codexHold = null;
  const r = codexUse(target.name);
  if (r.ok) {
    journalAppend({ provider: 'codex', event: 'switch', from: id.email, to: target.name, reason: `${id.email} ${Math.round(100 - usage.worst)}% left` });
    state.justSwitched = `codex ${id.email} → ${target.name}`;
    // restart supervised running sessions so they resume threads on the new account
    const { restarted, unsupervised } = await codexRestartSessions(state);
    notify('ai-acct-autopilot: Codex switched', `${id.email} → ${target.name}${restarted ? ` — resuming ${restarted} running session(s)` : ''}${unsupervised ? `; ${unsupervised} pre-shim session(s) need manual restart` : ''}`);
  } else {
    journalAppend({ provider: 'codex', event: 'switch-failed', from: id.email, to: target.name, error: r.error });
    notify('ai-acct-autopilot: Codex switch FAILED', r.error || 'check terminal');
  }
}

// ---------- codex subcommands ----------
// codex-add: log a NEW codex account into the bench WITHOUT revoking the
// current session. `codex login` inside a shared home revokes whatever token
// it replaces, so the login runs in a throwaway isolated CODEX_HOME and the
// resulting auth.json is imported as a saved account (verified 2026-06-12:
// isolated-home logins leave other sessions alive).
if (argv[0] === 'codex-add') {
  (async () => {
    const { spawnSync } = require('node:child_process');
    const state = readJson(SHIM_STATE) || {};
    const real = state.realTarget;
    if (!real) { console.error('codex shim state missing — run: ai-acct-autopilot codex-shim install'); process.exit(1); }
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-add-'));
    console.log('Opening codex login in an isolated home (current session stays alive).');
    console.log('Sign into the NEW account in the browser window.');
    const r = spawnSync(real, ['login'], { stdio: 'inherit', env: { ...process.env, CODEX_HOME: tmpHome } });
    const blob = readJson(path.join(tmpHome, 'auth.json'));
    const id = codexIdentity(blob);
    if (r.status !== 0 || !blob || !id || !id.email) {
      console.error('Login did not produce a usable auth.json — nothing imported.');
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
      process.exit(1);
    }
    const probe = await codexProbeUsage(blob.tokens && blob.tokens.access_token);
    fs.mkdirSync(CODEX_DIR, { recursive: true, mode: 0o700 });
    atomicWrite(path.join(CODEX_DIR, `${id.email}.json`), JSON.stringify(blob));
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
    console.log(`Added '${id.email}' (${id.plan || '?'}) to the codex bench${probe.ok ? ` — live, ${Math.round(100 - (probe.worst ?? 0))}% left` : ''}.`);
    console.log('It joins the dashboard and autopilot targeting immediately.');
    process.exit(0);
  })();
}
if (argv[0] === 'codex-save') {
  const email = codexSnapshotActive();
  if (email) { console.log(`Saved current codex account as '${email}'.`); process.exit(0); }
  console.error('No usable ~/.codex/auth.json (chatgpt login) found.'); process.exit(1);
}
if (argv[0] === 'codex-use') {
  const email = argv[1];
  if (!email) { console.error('usage: ai-acct-autopilot codex-use <email>'); process.exit(1); }
  const cur = codexIdentity(readJson(CODEX_AUTH));
  if (cur && cur.email === email) { console.log(`'${email}' is already the active codex account.`); process.exit(0); }
  const r = codexUse(email);
  if (!r.ok) { console.error(r.error); process.exit(1); }
  journalAppend({ provider: 'codex', event: 'switch', from: 'manual', to: email, reason: 'manual codex-use' });
  console.log(`Switched codex to '${email}'. New codex sessions use it now.`);
  (async () => {
    const { restarted, unsupervised } = await codexRestartSessions(null);
    if (restarted) console.log(`Restarting ${restarted} supervised running session(s) — they resume their threads on the new account.`);
    if (unsupervised) console.log(`${unsupervised} pre-shim session(s) keep the old account until restarted (openai/codex#17041).`);
    process.exit(0);
  })();
}
if (argv[0] === 'codex-list') {
  const blob = readJson(CODEX_AUTH);
  const id = codexIdentity(blob) || {};
  const saved = codexSavedAccounts();
  if (!saved.length && !id.email) { console.log('No codex accounts found.'); process.exit(0); }
  for (const e of new Set([...(id.email ? [id.email] : []), ...saved])) {
    const marks = [e === id.email ? 'live' : null, saved.includes(e) ? 'saved' : 'not saved — run codex-save'].filter(Boolean);
    console.log(`${e === id.email ? '*' : ' '} ${e} (${marks.join(', ')})`);
  }
  process.exit(0);
}

// codex-ensure: fast pre-launch check used by the codex shim. If the active
// codex account has < threshold % left (on FRESH data) and a better saved
// account exists, swap auth.json BEFORE the new codex process starts.
// Fail-open and quiet: any problem → exit 0 so codex always launches.
if (argv[0] === 'codex-ensure') {
  (async () => {
    try {
      const usage = codexUsage();
      const id = codexIdentity(readJson(CODEX_AUTH));
      if (!usage || !usage.fresh || !id || !id.email) process.exit(0);
      if (usage.worst === null || usage.worst < 100 - THRESHOLD) process.exit(0);
      if (now() - lastSwitchTs('codex') < COOLDOWN_MS) process.exit(0);
      // Live-probe saved accounts before picking (never switch into unprobed
      // usage). Only reached when the active account is hot, so the probe
      // latency lands exactly on the launches a switch would rescue.
      const target = codexPickTarget(id.email, await codexProbeAll());
      if (!target) process.exit(0);
      const r = codexUse(target.name);
      if (r.ok) {
        journalAppend({ provider: 'codex', event: 'switch', from: id.email, to: target.name, reason: `launch ensure: ${id.email} ${Math.round(100 - usage.worst)}% left` });
        notify('ai-acct-autopilot: Codex switched at launch', `${id.email} → ${target.name}`);
        if (!flag('--quiet')) console.error(`[ai-acct-autopilot] codex account switched: ${id.email} → ${target.name}`);
      }
    } catch {}
    process.exit(0);
  })();
}

// codex-shim: wrap the real codex binary as a SUPERVISOR. Every launch runs
// codex-ensure first (account decision at process start — running sessions
// never re-read auth.json). And when the watcher switches accounts, it
// terminates running codex processes after dropping a restart marker with the
// session id; the supervisor sees marker+death and relaunches
// `codex resume <session-id>` — same thread, fresh auth, no human.
function shimScript() {
  return `#!/bin/sh
${SHIM_MARK} v3 (node supervisor)
exec node "${__filename}" codex-supervise -- "$@"
`;
}

// Build the relaunch argv that resumes session `sid` while preserving the
// original launch flags (Superset prepends --enable hooks -c notify=[...]).
//   exec mode:  <args up to and incl. "exec"> resume <sid>
//   tui mode:   <flag args (values preserved)> resume <sid>   (positional prompt dropped)
const VALUE_FLAGS = new Set(['-c', '--config', '-m', '--model', '-p', '--profile',
  '--enable', '--disable', '-C', '--cd', '-s', '--sandbox', '-a', '--ask-for-approval',
  '-i', '--image', '--output-schema', '--output-last-message', '--color']);
function buildResumeArgs(args, sid) {
  const execIdx = (() => {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === 'exec') return i;
      if (a.startsWith('-')) { if (VALUE_FLAGS.has(a)) i++; continue; }
      return -1; // first positional isn't "exec" → tui with prompt
    }
    return -1;
  })();
  if (execIdx >= 0) return [...args.slice(0, execIdx + 1), 'resume', sid];
  const flags = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) {
      flags.push(a);
      if (VALUE_FLAGS.has(a) && i + 1 < args.length) flags.push(args[++i]);
    } // positional (initial prompt) dropped — the resumed thread already has it
  }
  return [...flags, 'resume', sid];
}

// The supervisor: launch the real codex, and when the watcher kills it after
// an account switch (restart marker present), relaunch `codex … resume <sid>`
// so the SAME thread continues on the new account. Without a marker, behave
// exactly like stock codex (mirror exit code/signal).
async function codexSupervise() {
  const { spawn } = require('node:child_process');
  const sep = argv.indexOf('--');
  const args = sep >= 0 ? argv.slice(sep + 1) : [];
  const state = readJson(SHIM_STATE) || {};
  const real = process.env.AI_CLI_WATCH_REAL || state.realTarget;
  if (!real) { console.error('[ai-acct-autopilot] shim state missing realTarget'); process.exit(127); }
  process.on('SIGINT', () => {});          // ctrl-c belongs to codex (turn interrupt)
  try { await new Promise((res) => execFile(process.execPath, [__filename, 'codex-ensure', '--quiet'], () => res())); } catch {}
  let launchArgs = args;
  for (;;) {
    const child = spawn(real, launchArgs, { stdio: 'inherit' });
    const { code, signal } = await new Promise((res) => child.on('exit', (c, s) => res({ code: c, signal: s })));
    const marker = path.join(RESTART_DIR, String(child.pid));
    let sid = null;
    try { sid = fs.readFileSync(marker, 'utf8').trim() || null; fs.rmSync(marker); } catch {
      // no marker → normal exit / user quit: mirror it
      if (signal) { try { process.kill(process.pid, signal); } catch {} process.exit(1); }
      process.exit(code == null ? 1 : code);
    }
    try { await new Promise((res) => execFile(process.execPath, [__filename, 'codex-ensure', '--quiet'], () => res())); } catch {}
    if (sid) {
      launchArgs = buildResumeArgs(args, sid);
      console.error(`[ai-acct-autopilot] account switched — resuming codex session ${sid} on the new account`);
    } else {
      launchArgs = args;
      console.error('[ai-acct-autopilot] account switched — relaunching codex on the new account');
    }
  }
}
if (argv[0] === 'codex-supervise') { codexSupervise(); }

// Running codex LAUNCHER processes (node codex.js): [{pid, supervised,
// descendants}]. The launcher is the right kill target — it forwards SIGTERM
// to the native codex binary and mirrors its exit. The native binary (a
// descendant) is what holds the rollout file open.
async function codexRunningProcs() {
  const state = readJson(SHIM_STATE) || {};
  const r = await run(PS_BIN, ['-axo', 'pid=,ppid=,command=']);
  const byPid = new Map();
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) byPid.set(Number(m[1]), { ppid: Number(m[2]), cmd: m[3] });
  }
  const childrenOf = (pid) => [...byPid.entries()].filter(([, v]) => v.ppid === pid).map(([p]) => p);
  const procs = [];
  for (const [pid, { ppid, cmd }] of byPid) {
    const isLauncher = (state.realTarget && cmd.includes(state.realTarget))
      || /@openai\/codex\/bin\/codex\.js/.test(cmd);
    if (!isLauncher || cmd.includes('app-server')) continue; // never touch the Codex.app server
    const parent = byPid.get(ppid);
    const supervised = !!(parent && parent.cmd.includes('codex-supervise'));
    const descendants = childrenOf(pid).flatMap((c) => [c, ...childrenOf(c)]);
    procs.push({ pid, supervised, descendants });
  }
  return procs;
}

// Session id of a running codex session = the uuid of the rollout file held
// open by the native binary (or the launcher itself, version-dependent).
async function codexSidOf(proc) {
  for (const pid of [proc.pid, ...proc.descendants]) {
    const r = await run(LSOF_BIN, ['-p', String(pid), '-Fn'], 10_000);
    const m = r.stdout.match(/rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]{36})\.jsonl/);
    if (m) return m[1];
  }
  return null;
}

// After a codex account switch: restart supervised running sessions so they
// resume their threads on the new account. Unsupervised ones (launched before
// the shim) can only be notified about.
async function codexRestartSessions(state) {
  const procs = await codexRunningProcs();
  if (!procs.length) return { restarted: 0, unsupervised: 0 };
  fs.mkdirSync(RESTART_DIR, { recursive: true, mode: 0o700 });
  let restarted = 0, unsupervised = 0;
  for (const p of procs) {
    if (!p.supervised) { unsupervised++; continue; }
    const sid = await codexSidOf(p);
    try {
      fs.writeFileSync(path.join(RESTART_DIR, String(p.pid)), sid || '', { mode: 0o600 });
      process.kill(p.pid, 'SIGTERM');
      restarted++;
      journalAppend({ provider: 'codex', event: 'session-restart', pid: p.pid, sid: sid || null });
    } catch { try { fs.rmSync(path.join(RESTART_DIR, String(p.pid))); } catch {} }
  }
  if (restarted || unsupervised) {
    const parts = [];
    if (restarted) parts.push(`${restarted} session(s) auto-resuming on the new account`);
    if (unsupervised) parts.push(`${unsupervised} pre-shim session(s) need a manual restart`);
    notify('ai-acct-autopilot: Codex sessions', parts.join('; '));
    if (state) state.codexHold = unsupervised ? `codex: ${unsupervised} pre-shim session(s) still on the old account — restart them manually` : state.codexHold;
  }
  return { restarted, unsupervised };
}
function findRealCodex(candidates = (CODEX_BIN_OVERRIDE ? [CODEX_BIN_OVERRIDE] : [
  '/opt/homebrew/bin/codex',
  path.join(HOME, '.bun', 'bin', 'codex'),
  '/usr/local/bin/codex',
])) {
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const text = fs.lstatSync(p).isSymbolicLink() ? '' : fs.readFileSync(p, 'utf8');
      const content = !text || !(text.includes(SHIM_MARK) || text.includes(SHIM_MARK_LEGACY));
      return { binPath: p, isShim: !content };
    } catch {}
  }
  return null;
}
// Dashboard nudge: a codex login without the shim means switches strand
// running sessions on the old account (openai/codex#17041). Nag only on a
// positively-detected stock binary; unknown locations stay quiet.
function shimHint(codexId, found) {
  if (!codexId || !codexId.email) return null;
  if (!found || found.isShim) return null;
  return 'shim not installed — codex switches won\'t auto-resume sessions · run: ai-acct-autopilot codex-shim install';
}
if (argv[0] === 'codex-shim') {
  const sub = argv[1] || 'status';
  const found = findRealCodex();
  if (!found) { console.error('codex binary not found in known locations.'); process.exit(1); }
  const state = readJson(SHIM_STATE);
  if (sub === 'status') {
    console.log(found.isShim ? `shim INSTALLED at ${found.binPath} (real: ${state && state.realTarget})`
      : `shim not installed — ${found.binPath} is the stock codex`);
    process.exit(0);
  }
  if (sub === 'install') {
    let realTarget;
    if (found.isShim) {
      const cur = fs.readFileSync(found.binPath, 'utf8');
      if (cur.includes(`${SHIM_MARK} v3`)) { console.log('shim v3 already installed.'); process.exit(0); }
      realTarget = (state && state.realTarget) || null;   // upgrade older shim
      if (!realTarget) { console.error('shim state missing; run codex-shim uninstall first.'); process.exit(1); }
    } else if (fs.lstatSync(found.binPath).isSymbolicLink()) {
      realTarget = fs.realpathSync(found.binPath);
    } else {
      // codex is a real file, not a symlink (direct-copy installs): move it
      // aside so the shim never records ITSELF as the real target. A realpath
      // comparison is NOT enough here (/var vs /private/var aliasing).
      realTarget = `${found.binPath}.real`;
      fs.renameSync(found.binPath, realTarget);
    }
    fs.writeFileSync(SHIM_STATE, JSON.stringify({ binPath: found.binPath, realTarget, installedAt: new Date().toISOString(), version: 3 }, null, 2));
    fs.rmSync(found.binPath, { force: true });
    fs.writeFileSync(found.binPath, shimScript(), { mode: 0o755 });
    console.log(`shim v3 (node supervisor) installed: ${found.binPath} → ensure + supervise → ${realTarget}`);
    console.log('On watcher-initiated account switches, supervised codex sessions auto-resume their threads.');
    console.log('NOTE: an npm upgrade of @openai/codex restores the stock binary (fail-safe); re-run codex-shim install after upgrades.');
    process.exit(0);
  }
  if (sub === 'uninstall') {
    if (!found.isShim || !state || !state.realTarget) { console.log('shim not installed.'); process.exit(0); }
    fs.rmSync(found.binPath);
    if (state.realTarget === `${found.binPath}.real`) fs.renameSync(state.realTarget, found.binPath);
    else fs.symlinkSync(state.realTarget, found.binPath);
    console.log(`shim removed: ${found.binPath} → ${state.realTarget}`);
    process.exit(0);
  }
  console.error('usage: ai-acct-autopilot codex-shim [status|install|uninstall]');
  process.exit(1);
}

// ════════════════════════ menubar app ════════════════════════
// CodexBar-style native macOS status-bar app. The Swift source (menubar/
// main.swift) is compiled on the user's machine with swiftc into a minimal
// .app bundle; the app then runs THIS script with --menubar as its data feed
// and shells back into it (codex-use) / claude-acct (use) for manual switches.
const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function menubarPaths() {
  return {
    app: MENUBAR_APP,
    bin: path.join(MENUBAR_APP, 'Contents', 'MacOS', 'AIAcctAutopilot'),
    resources: path.join(MENUBAR_APP, 'Contents', 'Resources'),
    infoPlist: path.join(MENUBAR_APP, 'Contents', 'Info.plist'),
  };
}
function menubarInfoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>${MENUBAR_LABEL}</string>
  <key>CFBundleName</key><string>AI Acct Autopilot</string>
  <key>CFBundleExecutable</key><string>AIAcctAutopilot</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${require('../package.json').version}</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppleEventsUsageDescription</key><string>Opens the terminal dashboard in Terminal.app when you ask for it.</string>
</dict></plist>
`;
}
function menubarLaunchAgent(binPath) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${MENUBAR_LABEL}</string>
  <key>ProgramArguments</key><array><string>${xmlEscape(binPath)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
</dict></plist>
`;
}
async function menubarBuild({ fromSource = false } = {}) {
  const p = menubarPaths();
  fs.mkdirSync(path.dirname(p.bin), { recursive: true });
  fs.mkdirSync(p.resources, { recursive: true });
  let source = 'prebuilt';
  if (!fromSource && fs.existsSync(MENUBAR_PREBUILT)) {
    // npm installs land here: no compiler, no Xcode, instant
    fs.copyFileSync(MENUBAR_PREBUILT, p.bin);
    fs.chmodSync(p.bin, 0o755);
  } else {
    if (!fs.existsSync(MENUBAR_SRC)) return { ok: false, error: `menubar Swift source missing: ${MENUBAR_SRC}` };
    source = 'compiled from source';
    const args = ['-O', '-parse-as-library', '-o', p.bin, MENUBAR_SRC];
    const r = SWIFTC_OVERRIDE ? await run(SWIFTC_OVERRIDE, args, 300_000)
      : await run('xcrun', ['-sdk', 'macosx', 'swiftc', ...args], 300_000);
    if (!r.ok) return { ok: false, error: `swiftc failed: ${(r.stderr || '').trim().slice(0, 800) || 'is Xcode / Command Line Tools installed? (xcode-select --install)'}` };
  }
  fs.writeFileSync(p.infoPlist, menubarInfoPlist());
  // absolute tool paths baked at build time — LaunchAgents get no user PATH
  const claudeAcct = acctBin.includes(path.sep) ? acctBin : path.join(__dirname, 'claude-acct');
  fs.writeFileSync(path.join(p.resources, 'config.json'), JSON.stringify({
    node: process.execPath, script: __filename, claudeAcct, builtAt: new Date().toISOString(),
  }, null, 2));
  return { ok: true, source };
}
if (argv[0] === 'menubar') {
  (async () => {
    const sub = argv[1] || 'status';
    const p = menubarPaths();
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    if (sub === 'build' || sub === 'install') {
      const fromSource = flag('--from-source');
      if (fromSource || !fs.existsSync(MENUBAR_PREBUILT)) console.log('Compiling the menu bar app (swiftc, ~10s)…');
      const b = await menubarBuild({ fromSource });
      if (!b.ok) { console.error(b.error); process.exit(1); }
      console.log(`Built ${p.app} (${b.source})`);
      if (sub === 'install') {
        fs.mkdirSync(path.dirname(MENUBAR_AGENT), { recursive: true });
        fs.writeFileSync(MENUBAR_AGENT, menubarLaunchAgent(p.bin));
        await run('launchctl', ['bootout', `gui/${uid}/${MENUBAR_LABEL}`]); // old instance; failure = wasn't running
        const l = await run('launchctl', ['bootstrap', `gui/${uid}`, MENUBAR_AGENT]);
        if (!l.ok) await run('open', [p.app]); // bootstrap denied (rare) → at least start it now
        console.log('Menu bar app running — it starts at login (launch agent installed).');
        console.log('Remove with: ai-acct-autopilot menubar uninstall');
      }
      process.exit(0);
    }
    if (sub === 'start') {
      if (!fs.existsSync(p.bin)) { console.error('not built — run: ai-acct-autopilot menubar install'); process.exit(1); }
      const r = await run('open', [p.app]);
      process.exit(r.ok ? 0 : 1);
    }
    if (sub === 'stop') {
      await run('launchctl', ['bootout', `gui/${uid}/${MENUBAR_LABEL}`]);
      console.log('Menu bar app stopped (if it was running).');
      process.exit(0);
    }
    if (sub === 'status') {
      const cfg = readJson(path.join(p.resources, 'config.json'));
      const ps = await run(PS_BIN, ['-axo', 'command=']);
      const running = ps.stdout.split('\n').some((l) => l.includes(p.bin));
      console.log(`app:    ${fs.existsSync(p.bin) ? `${p.app}${cfg ? ` (built ${cfg.builtAt})` : ''}` : 'not built — run: ai-acct-autopilot menubar install'}`);
      console.log(`agent:  ${fs.existsSync(MENUBAR_AGENT) ? MENUBAR_AGENT : 'not installed'}`);
      console.log(`state:  ${running ? 'running' : 'not running'}`);
      process.exit(0);
    }
    if (sub === 'uninstall') {
      await run('launchctl', ['bootout', `gui/${uid}/${MENUBAR_LABEL}`]);
      try { fs.rmSync(MENUBAR_AGENT, { force: true }); } catch {}
      try { fs.rmSync(MENUBAR_APP, { recursive: true, force: true }); } catch {}
      console.log('Menu bar app and launch agent removed.');
      process.exit(0);
    }
    console.error('usage: ai-acct-autopilot menubar [install|build|start|stop|status|uninstall]');
    process.exit(1);
  })();
}

// One status snapshot per tick for the menu bar app: the same data render()
// draws, as JSON. Alert levels follow the terminal palette contract — red
// means "needs the user", amber means "handled / informational".
function menubarSnapshot(report, state) {
  const alerts = [];
  const amber = (text) => alerts.push({ level: 'amber', text });
  const red = (text) => alerts.push({ level: 'red', text });

  const claude = { ok: !!report, active: (report && report.active) || null, accounts: [] };
  if (!report) red('claude-acct usage failed — retrying next tick');
  for (const res of (report && report.results) || []) {
    const rows = rowsFor(res);
    const worst = rows ? worstUsed(rows) : null;
    if (state.reauth.has(res.account)) amber(`claude ${res.account}: re-auth needed`);
    claude.accounts.push({
      name: res.account, email: res.email || null, subscription: res.subscriptionType || null,
      active: res.account === claude.active, recovery: isRecovery(res.account),
      reauth: state.reauth.has(res.account), rows: rows || [],
      percentLeft: worst === null ? null : Math.round(100 - worst),
      trend: trendFor(res.email || res.account) || null,
    });
  }

  const codexId = codexIdentity(readJson(CODEX_AUTH));
  const usage = codexUsage();
  const probes = state.codexProbes || new Map();
  const codex = { active: (codexId && codexId.email) || null, plan: (usage && usage.plan) || (codexId && codexId.plan) || null, accounts: [] };
  const hint = shimHint(codexId, findRealCodex());
  if (hint) amber(hint);
  if (codex.active) {
    const saved = codexSavedAccounts();
    for (const email of [codex.active, ...saved.filter((e) => e !== codex.active)]) {
      const isActive = email === codex.active;
      const p = probes.get(email);
      const dead = !!(p && !p.ok && (p.status === 401 || p.status === 403));
      const rows = (p && p.ok && p.rows) || (isActive && usage && usage.rows) || null;
      const worst = rows ? worstUsed(rows) : null;
      if (dead) amber(`codex ${email}: re-login needed — run: ai-acct-autopilot codex-add ${email}`);
      codex.accounts.push({
        email, active: isActive, saved: saved.includes(email), dead, rows: rows || [],
        percentLeft: worst === null ? null : Math.round(100 - worst),
        trend: (isActive && usage && usage.trend) || null,
      });
    }
  }

  if (state.holdReason) amber(state.holdReason);
  if (state.codexHold) amber(state.codexHold);
  const events = journalTail(5);
  for (const e of events) {
    if (e.event === 'switch-failed' && now() - new Date(e.ts).getTime() < 15 * 60_000) {
      red(`${e.provider || 'claude'} switch FAILED ${e.from} → ${e.to}`);
    }
  }
  return {
    v: 1, ts: new Date().toISOString(),
    mode: NO_SWITCH ? 'monitor' : 'auto', threshold: THRESHOLD, interval: INTERVAL,
    attention: alerts.some((a) => a.level === 'red') ? 'red' : alerts.length ? 'amber' : 'ok',
    alerts, claude, codex,
    stats: state.stats || null, statsProgress: state.statsProgress || null,
    events: events.slice().reverse(),
  };
}

// ════════════════════════ render ════════════════════════
function bar(used, width) {
  const u = used === null ? 0 : used;
  const filled = Math.round((u / 100) * width);
  const color = used === null ? C.grey2 : u >= 95 ? C.red : u >= 85 ? C.amber : C.tan;
  return color + '█'.repeat(filled) + C.grey2 + '░'.repeat(Math.max(0, width - filled)) + C.reset;
}
function fmtLeft(used) {
  if (used === null) return `${C.grey}–${C.reset}`;
  const left = Math.round(100 - used);
  const col = left <= THRESHOLD ? C.red : left <= 15 ? C.amber : C.white;
  return `${col}${left}% left${C.reset}`;
}

function render(report, state) {
  if (MENUBAR) {
    try { process.stdout.write(JSON.stringify(menubarSnapshot(report, state)) + '\n'); } catch {}
    return;
  }
  const cols = Math.max(72, process.stdout.columns || 100);
  const barW = Math.max(20, Math.min(44, cols - 52));
  const L = [];
  const pad = (s, n) => s + ' '.repeat(Math.max(0, n - stripLen(s)));
  const right = (left, rightTxt) => pad(left, cols - stripLen(rightTxt) - 1) + rightTxt;
  const divider = (label) => `  ${C.grey}${C.bold}${label}${C.reset}  ${C.grey2}${'─'.repeat(Math.max(4, cols - label.length - 8))}${C.reset}`;

  // header
  const mode = NO_SWITCH ? `${C.grey}MONITOR ONLY${C.reset}` : `${C.green}AUTO-SWITCH${C.reset}${C.grey} at <${THRESHOLD}% left${C.reset}`;
  const time = new Date().toLocaleTimeString();
  L.push('');
  L.push(right(`  ${C.bold}${C.white}◉ AI CLI Accounts${C.reset}   ${mode}`, `${C.grey}updated ${time}${C.reset}  `));
  L.push('');

  // ---- claude section ----
  L.push(divider('CLAUDE'));
  if (!report) {
    L.push(`  ${C.red}claude-acct usage failed — retrying next tick${C.reset}`);
  } else {
    for (const res of report.results) {
      const isActive = res.account === report.active;
      const email = res.email && res.email !== res.account ? `${C.grey}${res.email}${C.reset}` : '';
      const sub = res.subscriptionType ? `${C.grey2} · ${res.subscriptionType}${C.reset}` : '';
      const activeTag = isActive ? `${C.green}● ACTIVE${C.reset}` : (state.reauth.has(res.account) ? `${C.amber}re-auth needed${C.reset}` : '');
      const nameCol = isActive ? C.bold + C.orange : C.bold + C.white;
      L.push('');
      L.push(right(`  ${nameCol}${res.account}${C.reset}${sub}  ${email}`, `${activeTag}  `));
      if (isRecovery(res.account)) L.push(`    ${C.amber}recovered keychain snapshot — adopt with: claude-acct save <email>${C.reset}`);

      const rows = rowsFor(res);
      if (!rows) {
        const why = res.usage && (res.usage.status === 401 || res.usage.status === 403)
          ? (isActive ? 'token stale — re-snapshotting from keychain' : 'token expired — auto-refresh next tick or re-auth')
          : 'usage unavailable';
        L.push(`    ${C.grey2}${'·'.repeat(barW)}${C.reset}  ${C.grey}${why}${C.reset}`);
        continue;
      }
      for (const row of rows) {
        const reset = row.resetsAt ? `${C.grey}resets ${rel(row.resetsAt)}${C.reset}` : `${C.grey2}no active window${C.reset}`;
        const lbl = `${C.grey}${row.label.padEnd(7)}${C.reset}`;
        L.push(right(`    ${lbl}${bar(row.used, barW)}  ${fmtLeft(row.used)}`, reset + '  '));
      }
      const tr = trendFor(res.email || res.account);
      if (tr) L.push(`    ${C.grey}trend  ${C.reset}${C.tan}${C.dim}${tr}${C.reset}  ${C.grey2}5h window${C.reset}`);
    }
  }

  // ---- codex section ----
  L.push('');
  L.push(divider('CODEX'));
  const codexBlob = readJson(CODEX_AUTH);
  const codexId = codexIdentity(codexBlob);
  const usage = codexUsage();
  if (!codexId || !codexId.email) {
    L.push(`  ${C.grey}no codex chatgpt login found (~/.codex/auth.json)${C.reset}`);
  } else {
    const hint = shimHint(codexId, findRealCodex());
    if (hint) L.push(`  ${C.amber}▲ ${hint}${C.reset}`);
    const probes = state.codexProbes || new Map();
    const plan = (usage && usage.plan) || codexId.plan;
    const emails = [codexId.email, ...codexSavedAccounts().filter((e) => e !== codexId.email)];
    for (const email of emails) {
      const isActive = email === codexId.email;
      const p = probes.get(email);
      const dead = p && !p.ok && (p.status === 401 || p.status === 403);
      const tag = isActive ? `${C.green}● ACTIVE${C.reset}` : (dead ? `${C.amber}re-login needed${C.reset}` : '');
      const nameCol = isActive ? C.bold + C.orange : C.bold + C.white;
      L.push('');
      L.push(right(`  ${nameCol}${email}${C.reset}${isActive && plan ? `${C.grey2} · ${plan}${C.reset}` : ''}`, `${tag}  `));
      if (isActive && !codexSavedAccounts().includes(email)) L.push(`    ${C.grey}not snapshotted yet — run: ai-acct-autopilot codex-save${C.reset}`);

      const rows = p && p.ok ? p.rows : (isActive && usage ? usage.rows : null);
      if (!rows) {
        const why = dead
          ? `session revoked — revive with: ai-acct-autopilot codex-add ${email}`
          : (p && p.status === 0 ? 'probe failed — network?' : 'usage unknown');
        L.push(`    ${C.grey2}${'·'.repeat(barW)}${C.reset}  ${C.grey}${why}${C.reset}`);
        continue;
      }
      for (const row of rows) {
        const reset = row.resetsAt ? `${C.grey}resets ${rel(row.resetsAt)}${C.reset}` : `${C.grey2}no active window${C.reset}`;
        L.push(right(`    ${C.grey}${row.label.padEnd(7)}${C.reset}${bar(row.used, barW)}  ${fmtLeft(row.used)}`, reset + '  '));
      }
      if (isActive && usage && usage.trend) {
        L.push(`    ${C.grey}trend  ${C.reset}${C.tan}${C.dim}${usage.trend}${C.reset}  ${C.grey2}5h window (local sessions)${C.reset}`);
      }
    }
  }

  // ---- local-log stats panel (codexbar-style; account-independent) ----
  L.push('');
  L.push(divider('LOCAL USAGE · estimated at API rates · all accounts combined'));
  if (!state.stats) {
    L.push(`  ${C.grey}${state.statsProgress || 'scanning local session logs (first run takes a minute)…'}${C.reset}`);
  } else {
    const panel = (label, s, color) => {
      const money = (x, dash) => (x < 0.005 && dash ? '—' : `$${x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
      const tok = (n) => n == null ? '—'
        : n >= 1e9 ? `${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B`
        : n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`
        : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : String(n);
      const max = Math.max(...s.hist, 0);
      const blocks = '▁▂▃▄▅▆▇█';
      const hist = s.hist.map((v) => max > 0 && v > 0
        ? color + blocks[Math.max(0, Math.min(7, Math.round((v / max) * 7)))] + C.reset
        : C.grey2 + '▁' + C.reset).join('');
      return [
        `${C.bold}${color}${label}${C.reset}`,
        `${C.grey}today${C.reset}  ${C.white}${money(s.todayCost, true)}${C.reset}    ${C.grey}30d cost${C.reset}  ${C.white}${money(s.cost30)}${C.reset}`,
        `${C.grey}30d tokens${C.reset}  ${C.white}${tok(s.tokens30)}${C.reset}    ${C.grey}latest${C.reset}  ${C.white}${tok(s.lastTokens)}${C.reset}`,
        hist + ` ${C.grey2}30d${C.reset}`,
        `${C.grey2}top model: ${s.topModel || '—'}${C.reset}`,
      ];
    };
    const cl = panel('CLAUDE', state.stats.claude, C.tan);
    const cx = panel('CODEX', state.stats.codex, C.blue);
    const colW = Math.floor((cols - 6) / 2);
    if (cols >= 104) {
      for (let i = 0; i < Math.max(cl.length, cx.length); i++) {
        L.push(`  ${pad(cl[i] || '', colW)}${cx[i] || ''}`);
      }
    } else {
      for (const l of cl) L.push(`  ${l}`);
      L.push('');
      for (const l of cx) L.push(`  ${l}`);
    }
    if (state.statsProgress) L.push(`  ${C.grey2}${state.statsProgress}${C.reset}`);
  }

  // events + footer
  L.push('');
  L.push(`  ${C.grey2}${'─'.repeat(cols - 4)}${C.reset}`);
  if (state.justSwitched) L.push(`  ${C.green}⇄ switched ${state.justSwitched}${C.reset}`);
  if (state.holdReason) L.push(`  ${C.amber}▲ ${state.holdReason}${C.reset}`);
  if (state.codexHold) L.push(`  ${C.amber}▲ ${state.codexHold}${C.reset}`);
  for (const e of journalTail(3)) {
    const t = new Date(e.ts).toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const prov = e.provider && e.provider !== 'claude' ? `${e.provider} ` : '';
    const what = e.event === 'switch' ? `${prov}${e.from} → ${e.to}${e.reason ? `  (${e.reason})` : ''}`
      : e.event === 'all-hot' ? `${prov}all accounts hot — held`
      : e.event === 'snapshot' ? `re-snapshotted ${e.account} from keychain`
      : e.event === 'switch-failed' ? `${prov}switch FAILED ${e.from} → ${e.to}` : `${prov}${e.event}`;
    L.push(`  ${C.grey2}${t}${C.reset}  ${C.grey}${what}${C.reset}`);
  }
  state.footerRow = L.length + 1;
  L.push(`  ${C.grey2}next check in ${INTERVAL}s · codex switches apply to new sessions · ctrl-c to quit${C.reset}`);

  if (PLAIN) { console.log(L.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')); return; }
  const out = L.map((l) => l + '\x1b[K').join('\n') + '\n\x1b[J';
  process.stdout.write('\x1b[H' + out);
}

// ════════════════════════ main loop ════════════════════════
async function tick(state) {
  codexUsageCache = null;
  // 1. self-heal: refresh stale non-active claude blobs
  const live = liveEmail();
  for (const name of accountNames()) {
    if (isRecovery(name)) continue;
    const mail = emailOf(name);
    if (live && (name === live || (mail && mail === live))) continue; // keychain owns the active account
    if (state.lastReport && name === state.lastReport.active) continue;
    if (tokenStale(name)) await refreshBlob(name, state);
  }
  // 2. poll usage (claude via claude-acct; codex via wham probes per account)
  const report = await fetchUsage();
  if (report) { state.lastReport = report; persistEmails(report); }
  try { state.codexProbes = await codexProbeAll(); } catch {}
  // keep the active codex account's saved blob fresh (the live CLI rotates
  // tokens in auth.json; mirror them so switching away never strands it)
  try {
    const live = readJson(CODEX_AUTH);
    const id = codexIdentity(live);
    if (id && id.email) {
      const saved = readJson(path.join(CODEX_DIR, `${id.email}.json`));
      if (!saved || (saved.tokens && live.tokens && saved.tokens.access_token !== live.tokens.access_token)) codexSnapshotActive();
    }
  } catch {}
  // 3. self-heal active (re-snapshot from keychain on 401), then autopilots
  if (report) {
    const healed = await healActive(report, state);
    if (!healed) await claudeAutopilot(report, state);
  }
  await codexAutopilot(state);
  // 4. render
  render(report || state.lastReport, state);
  state.justSwitched = null;
}

// Synthetic decision-logic self-test (no network, no account mutation).
function testDecision() {
  const W = (fh, wk) => ({ ok: true, data: {
    five_hour: { utilization: fh, resets_at: '2099-01-01T00:00:00Z' },
    seven_day: { utilization: wk, resets_at: '2099-01-02T00:00:00Z' },
  } });
  const mk = (account, usage) => ({ account, usage });
  let pass = 0, fail = 0;
  const check = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); };

  let rep = { active: 'main', results: [mk('main', W(96, 50)), mk('alt2', W(12, 31)), mk('alt3', W(64, 40))] };
  check('claude: 5h trigger picks lowest-worst target', (pickTarget(rep, 'main') || {}).name === 'alt2');
  check('claude: worstUsed takes max of 5h/weekly', worstUsed(rowsFor(rep.results[0])) === 96);

  rep = { active: 'main', results: [mk('main', W(10, 97)), mk('alt2', W(12, 31))] };
  check('claude: weekly window also triggers (worst=97)', worstUsed(rowsFor(rep.results[0])) === 97);

  rep = { active: 'main', results: [mk('main', W(96, 50)), mk('alt2', W(99, 10)), mk('alt3', { ok: false, status: 401 })] };
  check('claude: all-hot — near-dead + unknown-usage excluded', pickTarget(rep, 'main') === null);

  rep = { active: 'main', results: [mk('main', W(96, 50)), mk('unsaved-live-x', W(5, 5)), mk('alt2', W(40, 20))] };
  check('claude: recovery blobs never targeted', (pickTarget(rep, 'main') || {}).name === 'alt2');

  rep = { active: 'main', results: [mk('main', W(50, 50)), mk('alt2', W(5, 5))] };
  check('claude: no trigger below threshold (worst=50)', worstUsed(rowsFor(rep.results[0])) < 100 - THRESHOLD);

  // model sub-windows: active opus is displayed, sonnet never is
  const subWin = (u, active) => ({ utilization: u, resets_at: active ? '2099-01-03T00:00:00Z' : undefined });
  const subRows = rowsFor({ account: 'x', usage: { ok: true, data: {
    five_hour: subWin(10, true), seven_day: subWin(20, true),
    seven_day_opus: subWin(30, true), seven_day_sonnet: subWin(40, true),
  } } });
  check('claude: sonnet window never displayed, active opus is',
    JSON.stringify(subRows.map((r) => r.key)) === JSON.stringify(['five_hour', 'seven_day', 'seven_day_opus']));
  const idleOpus = rowsFor({ account: 'x', usage: { ok: true, data: {
    five_hour: subWin(10, true), seven_day: subWin(20, true), seven_day_opus: subWin(0, false),
  } } });
  check('claude: inactive opus window hidden', idleOpus.every((r) => r.key !== 'seven_day_opus'));

  // codex: primary/secondary map to the same decision shape
  const codexRows = [
    { label: '5h', key: 'five_hour', used: 97, resetsAt: '2099-01-01T00:00:00Z' },
    { label: 'weekly', key: 'seven_day', used: 12, resetsAt: '2099-01-02T00:00:00Z' },
  ];
  check('codex: primary window drives worst (97)', worstUsed(codexRows) === 97);
  check('codex: sparkline dedupes flat samples', sparkline(dedupeAdjacent([0, 0, 50, 50, 100])) === '▁▅█');

  // wham/usage response mapping (probed shape verified live 2026-06-12:
  // windows nest under rate_limit; email/plan_type at top level)
  const wham = mapWham({ email: 'a@x.com', plan_type: 'pro', rate_limit: { allowed: true, limit_reached: false,
    primary_window: { used_percent: 35, limit_window_seconds: 18000, reset_at: 1781225541 },
    secondary_window: { used_percent: 56, limit_window_seconds: 604800, reset_at: 1781812341 } },
    additional_rate_limits: [{ limit_name: 'GPT-5.3-Codex-Spark' }] });
  check('codex: wham maps primary/secondary to 5h/weekly rows',
    wham.rows.length === 2 && wham.rows[0].key === 'five_hour' && wham.rows[1].key === 'seven_day');
  check('codex: wham worst = max window (56)', wham.worst === 56);

  // resume-arg construction preserves launch flags (Superset prepends them)
  const SS = ['--enable', 'hooks', '-c', 'notify=["bash","/x/notify.sh"]'];
  check('shim: exec resume keeps superset flags',
    JSON.stringify(buildResumeArgs([...SS, 'exec', 'Write a story'], 'SID')) === JSON.stringify([...SS, 'exec', 'resume', 'SID']));
  check('shim: tui resume keeps flags, drops prompt',
    JSON.stringify(buildResumeArgs([...SS, 'fix the bug'], 'SID')) === JSON.stringify([...SS, 'resume', 'SID']));
  check('shim: bare tui resume', JSON.stringify(buildResumeArgs([], 'SID')) === JSON.stringify(['resume', 'SID']));

  // bucket selection: regular limit beats special model-family buckets
  let buckets = {
    codex_bengalfox: { ts: 2000, rl: { limit_name: 'GPT-5.3-Codex-Spark', primary: {} } },
    codex: { ts: 1000, rl: { limit_name: null, primary: {} } },
  };
  check('codex: "codex" bucket wins over newer Spark bucket', chooseBucket(buckets) === buckets.codex);
  buckets = {
    a_named: { ts: 2000, rl: { limit_name: 'Special', primary: {} } },
    b_unnamed: { ts: 1000, rl: { limit_name: null, primary: {} } },
  };
  check('codex: unnamed bucket preferred when no "codex" id', chooseBucket(buckets) === buckets.b_unnamed);

  // shim hint: nag only when a codex login meets a positively-detected stock binary
  const cid = { email: 'a@x.com' };
  const nag = shimHint(cid, { binPath: '/x/codex', isShim: false });
  check('hint: stock binary + login → nag names the fix', !!nag && nag.includes('codex-shim install'));
  check('hint: shim installed → quiet', shimHint(cid, { binPath: '/x/codex', isShim: true }) === null);
  check('hint: no codex binary found → quiet', shimHint(cid, null) === null);
  check('hint: no codex login → quiet', shimHint(null, { binPath: '/x/codex', isShim: false }) === null);
  check('hint: identity without email → quiet', shimHint({}, { binPath: '/x/codex', isShim: false }) === null);

  // shim detection on disk (tmpdir; candidate list injected — real paths untouched)
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'aaa-shim-test-'));
  try {
    const stock = path.join(tdir, 'stock'); fs.writeFileSync(stock, '#!/bin/sh\necho codex\n');
    const shim = path.join(tdir, 'shim'); fs.writeFileSync(shim, `#!/usr/bin/env node\n${SHIM_MARK} v3\n`);
    const legacy = path.join(tdir, 'legacy'); fs.writeFileSync(legacy, `#!/usr/bin/env node\n${SHIM_MARK_LEGACY} v2\n`);
    const link = path.join(tdir, 'link'); fs.symlinkSync(stock, link);
    check('detect: real file without mark = stock', findRealCodex([stock]).isShim === false);
    check('detect: shim mark = shim', findRealCodex([shim]).isShim === true);
    check('detect: legacy mark = shim (upgrade in place)', findRealCodex([legacy]).isShim === true);
    check('detect: symlink = stock (shim is written as a real file)', findRealCodex([link]).isShim === false);
    check('detect: nothing found = null', findRealCodex([path.join(tdir, 'missing')]) === null);
    check('detect: first candidate wins', findRealCodex([shim, stock]).binPath === shim);
  } finally { fs.rmSync(tdir, { recursive: true, force: true }); }

  // menubar snapshot: claude mapping + alert contract (the codex side and the
  // full stream run live in the sandboxed e2e suite). Only claude/alert fields
  // are asserted — the codex fields read this machine's real (read-only) state.
  const mbState = { reauth: new Set(['alt2']), codexProbes: new Map(), holdReason: 'claude: cooldown — would switch to alt2', codexHold: null, stats: null, statsProgress: null };
  const mbRep = { active: 'main', results: [mk('main', W(96, 50)), mk('alt2', W(12, 31))] };
  const snap = menubarSnapshot(mbRep, mbState);
  check('menubar: active account mapped with percentLeft', snap.claude.accounts[0].active === true && snap.claude.accounts[0].percentLeft === 4);
  check('menubar: reauth flag + amber alert', snap.claude.accounts[1].reauth === true && snap.alerts.some((a) => a.level === 'amber' && a.text.includes('re-auth')));
  check('menubar: hold reason becomes an amber alert', snap.alerts.some((a) => a.level === 'amber' && a.text.includes('cooldown')));
  check('menubar: failed usage fetch → red attention', menubarSnapshot(null, { reauth: new Set() }).attention === 'red');
  check('menubar: launch agent plist xml-escapes the binary path', menubarLaunchAgent('/x/<&>app').includes('/x/&lt;&amp;&gt;app'));
  check('menubar: app bundle plist is a UI-less agent', menubarInfoPlist().includes('<key>LSUIElement</key><true/>'));

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
if (flag('--test-decision')) testDecision();

async function main() {
  const state = { reauth: new Set(), holdReason: null, codexHold: null, justSwitched: null, lastHealTry: 0, allHotNotified: false, codexAllHot: false, lastReport: null, footerRow: 0, stats: null, statsProgress: null };
  if (!PLAIN) {
    process.stdout.write('\x1b[2J\x1b[H\x1b[?25l');
    const cleanup = () => { process.stdout.write('\x1b[?25h\x1b[0m\n'); process.exit(0); };
    process.on('SIGINT', cleanup); process.on('SIGTERM', cleanup);
  }
  state.stats = usageStats.cachedStats();  // instant render from last scan
  let nextAt = now() + INTERVAL * 1000;
  let wake = null;
  // SIGUSR2 = "tick now" (the menu bar app's Refresh / post-switch poke).
  // Registered before the first tick so an early poke can't kill the process.
  // (SIGUSR1 is off limits: node reserves it for the inspector.)
  process.on('SIGUSR2', () => { nextAt = now(); if (wake) wake(); });

  const runStats = async () => {
    try {
      const s = await usageStats.collect((done, total) => {
        state.statsProgress = `scanning local logs… ${done}/${total} files`;
      });
      if (s) state.stats = s;
      state.statsProgress = null;
      // rerender only after a tick produced data — a fast stats scan must not
      // flash "usage failed" (red) before the first usage poll completes
      if (!ONCE && state.lastReport) render(state.lastReport, state);
    } catch { state.statsProgress = null; }
  };

  if (ONCE) { await runStats(); await tick(state); if (!PLAIN) process.stdout.write('\x1b[?25h'); return; }
  // e2e seam: bounded interactive run that still flushes V8 coverage on exit
  // (a signal kill would discard it). No effect unless the env var is set.
  if (process.env.AI_ACCT_EXIT_AFTER_MS) {
    setTimeout(() => { if (!PLAIN) process.stdout.write('\x1b[?25h\x1b[0m\n'); process.exit(0); }, Number(process.env.AI_ACCT_EXIT_AFTER_MS));
  }
  // the menu bar app dies → its read pipe closes → exit instead of crashing
  if (MENUBAR) process.stdout.on('error', () => process.exit(0));

  runStats();                              // background; rerenders when done
  setInterval(runStats, 5 * 60_000);       // refresh stats every 5 min
  await tick(state);

  nextAt = now() + INTERVAL * 1000;
  setInterval(() => {        // per-second countdown on the footer line
    if (PLAIN || !state.footerRow) return;
    const s = Math.max(0, Math.ceil((nextAt - now()) / 1000));
    process.stdout.write(`\x1b[${state.footerRow};1H  ${C.grey2}next check in ${s}s · codex switches apply to new sessions · ctrl-c to quit${C.reset}\x1b[K`);
  }, 1000);
  // serial tick loop (never overlapping); wake() lets SIGUSR1 cut the sleep short
  (async function loop() {
    for (;;) {
      await new Promise((r) => { wake = r; setTimeout(r, Math.max(0, nextAt - now())); });
      wake = null;
      nextAt = now() + INTERVAL * 1000;
      try { await tick(state); } catch {}
    }
  })();
}

// Subcommands exit on their own (codex-use asynchronously); only the
// dashboard path runs the main loop.
if (!['codex-save', 'codex-use', 'codex-list', 'codex-shim', 'codex-ensure', 'codex-supervise', 'codex-add', 'menubar'].includes(argv[0])) main();
