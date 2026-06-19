#!/usr/bin/env node
// Sandboxed end-to-end suite for ai-acct-autopilot.
//
// Every scenario runs bin/ai-acct-autopilot.js as a child process inside a
// throwaway $HOME with:
//   • fake `claude-acct` / `osascript` shadowed on PATH,
//   • a local TLS mock serving the OAuth-refresh and wham/usage endpoints
//     (via the AI_ACCT_OAUTH_URL / AI_ACCT_WHAM_URL seams),
//   • fake `ps` / `lsof` (AI_ACCT_PS_BIN / AI_ACCT_LSOF_BIN) — the default
//     fake prints an EMPTY process table so codexRestartSessions can never
//     observe (or signal) real codex sessions; the restart scenario builds a
//     synthetic table whose pids are `sleep` processes this suite spawned.
//
// The real keychain, real network, and real processes are never touched.
// Run: node test/e2e.js   (or `npm test` / `npm run coverage`)
'use strict';
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin', 'ai-acct-autopilot.js');
const NODE_DIR = path.dirname(process.execPath);
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aaa-e2e-'));
const SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  e2e: ${name}${cond || !detail ? '' : `\n        got: ${String(detail).slice(0, 300)}`}`);
};

// ---------- fixtures ----------
const b64u = (s) => Buffer.from(s).toString('base64url');
const jwt = (email, plan = 'pro') =>
  `${b64u('{"alg":"none"}')}.${b64u(JSON.stringify({ email, 'https://api.openai.com/auth': { chatgpt_plan_type: plan } }))}.sig`;
const codexBlob = (email, token) =>
  JSON.stringify({ tokens: { id_token: jwt(email), access_token: token, refresh_token: `rt-${email}` } });
const claudeBlob = ({ refresh = 'rt-good', expiresAt = Date.now() + 3600_000 } = {}) =>
  JSON.stringify({ claudeAiOauth: { accessToken: 'at-old', refreshToken: refresh, expiresAt } });
const claudeUsage = (fh, wk) => ({ ok: true, data: {
  five_hour: { utilization: fh, resets_at: new Date(Date.now() + 3600_000).toISOString() },
  seven_day: { utilization: wk, resets_at: new Date(Date.now() + 86400_000).toISOString() },
} });
const epoch = (ms) => Math.floor((Date.now() + ms) / 1000);

function sandbox(name) {
  const home = path.join(ROOT, name);
  const bin = path.join(home, 'bin');
  for (const d of ['.claude/accounts', '.codex/accounts', '.codex/sessions', 'fixtures']) {
    fs.mkdirSync(path.join(home, d), { recursive: true });
  }
  fs.mkdirSync(bin, { recursive: true });
  const sh = (file, body) => {
    fs.writeFileSync(path.join(bin, file), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return path.join(bin, file);
  };
  sh('claude-acct', `case "$1" in
  usage) cat "${home}/fixtures/usage.json"; exit 0;;
  use) echo "use $2" >> "${home}/fixtures/calls.log"; [ "$2" = "failme@test" ] && exit 1; printf '%s\n' "$2" > "${home}/.claude/accounts/.active"; node - "${home}/fixtures/usage.json" "$2" <<'NODE'
const fs = require('fs');
const [file, active] = process.argv.slice(2);
try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); j.active = active; fs.writeFileSync(file, JSON.stringify(j)); } catch {}
NODE
  exit 0;;
  save) echo "save $2" >> "${home}/fixtures/calls.log"; exit 0;;
esac
exit 0`);
  sh('osascript', `echo "$@" >> "${home}/fixtures/notify.log"; exit 0`);
  // Empty process table by default: restart logic sees no codex processes.
  const fakePs = sh('fakeps', 'exit 0');
  const fakeLsof = sh('fakelsof', 'exit 0');
  const fakePgrep = sh('fakepgrep', 'exit 1');
  return {
    home, bin, sh, fakePs, fakeLsof, fakePgrep,
    write(rel, content) {
      const p = path.join(home, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
      return p;
    },
    read(rel) { try { return fs.readFileSync(path.join(home, rel), 'utf8'); } catch { return ''; } },
    json(rel) { try { return JSON.parse(this.read(rel)); } catch { return null; } },
    journal() { return this.read('.claude/accounts/switch-journal.jsonl').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); },
  };
}

function writeRollout(sb, { used = 50, weekly = 20, ageMs = 60_000, limitId = 'codex', limitName = null, extraSpark = false } = {}) {
  const line = (id, name, u, t) => JSON.stringify({ timestamp: new Date(Date.now() - t).toISOString(), payload: { rate_limits: {
    limit_id: id, limit_name: name,
    primary: { used_percent: u, resets_at: epoch(3600_000), limit_window_seconds: 18000 },
    secondary: { used_percent: weekly, resets_at: epoch(86400_000), limit_window_seconds: 604800 },
  } } });
  const lines = [line(limitId, limitName, Math.max(0, used - 10), ageMs + 60_000), line(limitId, limitName, used, ageMs)];
  if (extraSpark) lines.push(line('codex_bengalfox', 'GPT-5.3-Codex-Spark', 5, ageMs - 1000));
  sb.write(`.codex/sessions/2026/06/12/rollout-2026-06-12T00-00-00-${SID}.jsonl`, lines.join('\n') + '\n');
}

// ---------- local TLS mock (OAuth refresh + wham usage) ----------
function makeCert() {
  const dir = path.join(ROOT, 'tls');
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
  return { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) };
}
// The mock MUST live in its own process: the suite drives the CLI with
// spawnSync, which blocks this process's event loop — an in-process server
// could never answer the child and every probe would eat its 15s timeout.
function startMock() {
  const { key, cert } = (() => { makeCert(); return { key: path.join(ROOT, 'tls', 'key.pem'), cert: path.join(ROOT, 'tls', 'cert.pem') }; })();
  const mockSrc = `
'use strict';
const fs = require('node:fs'); const https = require('node:https');
const epoch = (ms) => Math.floor((Date.now() + ms) / 1000);
const server = https.createServer({ key: fs.readFileSync(process.argv[2]), cert: fs.readFileSync(process.argv[3]) }, (req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.url.startsWith('/oauth')) {
      let rt = null; try { rt = JSON.parse(body).refresh_token; } catch {}
      if (rt === 'rt-good') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'at-new', refresh_token: 'rt-good-2', expires_in: 3600 }));
      } else if (rt === 'rt-neterr') { req.destroy(); }
      else { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"invalid_grant"}'); }
      return;
    }
    if (req.url.startsWith('/wham')) {
      const m = (req.headers.authorization || '').match(/^Bearer tok-(\\d+)$/);
      if (m) {
        const used = Number(m[1]);
        const reply = () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ plan_type: 'pro', rate_limit: {
            primary_window: { used_percent: used, reset_at: epoch(3600_000), limit_window_seconds: 18000 },
            secondary_window: { used_percent: Math.min(used, 40), reset_at: epoch(86400_000), limit_window_seconds: 604800 },
          } }));
        };
        if (used === 88) setTimeout(reply, 2500);
        else reply();
      } else if (/tok-neterr/.test(req.headers.authorization || '')) { req.destroy(); }
      else { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'token_revoked' } })); }
      return;
    }
    if (req.url.startsWith('/release')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        tag_name: 'v9.8.7',
        html_url: 'https://github.test/alnimra/ai-acct-autopilot/releases/tag/v9.8.7',
        assets: [
          { name: 'AI-Acct-Autopilot-9.8.7.dmg', browser_download_url: 'https://github.test/alnimra/ai-acct-autopilot/releases/download/v9.8.7/AI-Acct-Autopilot-9.8.7.dmg' },
        ],
      }));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
});
server.listen(0, '127.0.0.1', () => console.log('PORT:' + server.address().port));
`;
  const mockPath = path.join(ROOT, 'mock.js');
  fs.writeFileSync(mockPath, mockSrc);
  const proc = spawn(process.execPath, [mockPath, key, cert], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    let buf = '';
    const to = setTimeout(() => reject(new Error('mock server failed to start')), 10_000);
    proc.stdout.on('data', (c) => {
      buf += c;
      const m = buf.match(/PORT:(\d+)/);
      if (m) { clearTimeout(to); resolve({ proc, port: Number(m[1]) }); }
    });
    proc.on('exit', () => { clearTimeout(to); reject(new Error('mock server exited early')); });
  });
}

let PORT = 0;
function runCli(sb, args, extraEnv = {}, opts = {}) {
  const env = {
    HOME: sb.home,
    PATH: `${sb.bin}:${NODE_DIR}:/usr/bin:/bin:/usr/sbin:/sbin`,
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    AI_ACCT_OAUTH_URL: `https://127.0.0.1:${PORT}/oauth`,
    AI_ACCT_WHAM_URL: `https://127.0.0.1:${PORT}/wham`,
    AI_ACCT_PS_BIN: sb.fakePs,     // safety: never observe real processes
    AI_ACCT_LSOF_BIN: sb.fakeLsof,
    AI_ACCT_PGREP_BIN: sb.fakePgrep,
    AI_ACCT_DISABLE_UPDATE_CHECK: '1',
    TERM: 'dumb',
    ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
    ...extraEnv,
  };
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: opts.timeout || 90_000, env });
}
function runScript(sb, script, args, extraEnv = {}, opts = {}) {
  const env = {
    HOME: sb.home,
    PATH: `${sb.bin}:${NODE_DIR}:/usr/bin:/bin:/usr/sbin:/sbin`,
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    AI_ACCT_OAUTH_URL: `https://127.0.0.1:${PORT}/oauth`,
    AI_ACCT_WHAM_URL: `https://127.0.0.1:${PORT}/wham`,
    AI_ACCT_PS_BIN: sb.fakePs,
    AI_ACCT_LSOF_BIN: sb.fakeLsof,
    AI_ACCT_PGREP_BIN: sb.fakePgrep,
    AI_ACCT_DISABLE_UPDATE_CHECK: '1',
    TERM: 'dumb',
    ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
    ...extraEnv,
  };
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: opts.timeout || 90_000, env });
}

// Standard claude+codex world: active claude a@test, bench b@test; active
// codex cx-a@test, bench cx-b@test. Healthy unless overridden.
function standardWorld(sb, { claudeActiveUsed = 50, codexActiveTok = 'tok-30' } = {}) {
  sb.write('.claude.json', JSON.stringify({ oauthAccount: { emailAddress: 'a@test' } }));
  sb.write('.claude/accounts/a@test.json', claudeBlob());
  sb.write('.claude/accounts/b@test.json', claudeBlob());
  sb.write('.claude/accounts/a@test.meta', 'email=a@test\n');
  sb.write('.claude/accounts/b@test.meta', 'email=b@test\n');
  sb.write('fixtures/usage.json', JSON.stringify({ active: 'a@test', results: [
    { account: 'a@test', email: 'a@test', subscriptionType: 'max', usage: claudeUsage(claudeActiveUsed, 30) },
    { account: 'b@test', email: 'b@test', usage: claudeUsage(10, 5) },
    { account: 'unsaved-live-7', usage: claudeUsage(1, 1) },
    { account: 'c@test', usage: { ok: false, status: 500 } },
  ] }));
  sb.write('.codex/auth.json', codexBlob('cx-a@test', codexActiveTok));
  sb.write('.codex/accounts/cx-b@test.json', codexBlob('cx-b@test', 'tok-10'));
}

(async () => {
  const mock = await startMock();
  PORT = mock.port;
  global.__mock = mock.proc;

  // ── S1: --help
  {
    const sb = sandbox('s1');
    const r = runCli(sb, ['--help']);
    check('help exits 0 and documents subcommands', r.status === 0 && r.stdout.includes('codex-add') && r.stdout.includes('codex-use') && r.stdout.includes('app-state'), r.stdout);
  }

  // ── S2: healthy monitor-only tick — renders both providers, switches nothing
  {
    const sb = sandbox('s2');
    standardWorld(sb);
    // session logs for the cost panel: claude models exercise every price
    // branch (exact, date-suffix strip, prefix match, haiku/opus/fable class)
    const ts = new Date().toISOString();
    const cl = (model, id) => JSON.stringify({ type: 'assistant', timestamp: ts, requestId: `r${id}`, message: {
      id: `m${id}`, model, usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 200, cache_read_input_tokens: 4000 } } });
    sb.write('.claude/projects/p/sess.jsonl', [
      cl('claude-opus-4-8-20250901', 1), cl('claude-haiku-4-5', 2), cl('claude-fable-5', 3), cl('claude-mystery-9', 4), cl('claude-mystery-9', 4),
    ].join('\n') + '\n');
    const d = new Date();
    const dayDir = `.codex/sessions/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
    sb.write(`${dayDir}/rollout-stats-x.jsonl`, [
      JSON.stringify({ type: 'turn_context', timestamp: ts, payload: { model: 'gpt-5.5-codex' } }),
      JSON.stringify({ timestamp: ts, payload: { type: 'token_count', info: {
        last_token_usage: { input_tokens: 2000, cached_input_tokens: 500, output_tokens: 800 },
        total_token_usage: { total_tokens: 3300 }, model_context_window: 200000 } } }),
    ].join('\n') + '\n');
    sb.write('.claude/accounts/usage-history.json', JSON.stringify({ accounts: { 'a@test': { five_hour: [{ usedPercent: 10 }, { usedPercent: 50 }] } } }));
    // seed journal with one of each event type so the footer formats them all
    const old = new Date(Date.now() - 3600_000).toISOString();
    sb.write('.claude/accounts/switch-journal.jsonl', [
      JSON.stringify({ ts: old, provider: 'claude', event: 'switch', from: 'x@t', to: 'y@t', reason: 'r' }),
      JSON.stringify({ ts: old, provider: 'codex', event: 'all-hot', active: 'x' }),
      JSON.stringify({ ts: old, provider: 'claude', event: 'snapshot', account: 'a@test' }),
      JSON.stringify({ ts: old, provider: 'codex', event: 'switch-failed', from: 'x', to: 'y' }),
      JSON.stringify({ ts: old, provider: 'codex', event: 'session-restart', pid: 1 }),
    ].join('\n') + '\n');
    const r = runCli(sb, ['--once', '--no-switch', '--plain']);
    check('healthy tick renders claude + codex sections', r.status === 0 && r.stdout.includes('CLAUDE') && r.stdout.includes('cx-a@test'), r.stdout || r.stderr);
    check('monitor mode shows MONITOR ONLY', r.stdout.includes('MONITOR ONLY'));
    check('healthy tick switches nothing', !sb.read('fixtures/calls.log').includes('use '));
    check('email persisted to .meta for new account', sb.read('.claude/accounts/b@test.meta').includes('email=b@test'));
    check('active codex account auto-snapshotted', !!sb.json('.codex/accounts/cx-a@test.json'));
    check('trend sparkline rendered from history', r.stdout.includes('trend'));
    check('recovery blob renders adoption guidance', r.stdout.includes('recovered keychain snapshot'), r.stdout);
    check('unusable benched usage renders as unavailable', r.stdout.includes('usage unavailable'), r.stdout);
    check('cost panel prices local session logs', /today\s+\$/.test(r.stdout) && r.stdout.includes('top model:'), r.stdout);
    const r2 = runCli(sb, ['--once', '--no-switch', '--plain']);
    check('second tick reuses the stats cache incrementally', r2.status === 0 && /30d cost/.test(r2.stdout), r2.stdout);
  }

  // ── S3: claude hot → real switch through fake claude-acct
  {
    const sb = sandbox('s3');
    standardWorld(sb, { claudeActiveUsed: 97 });
    const r = runCli(sb, ['--once', '--plain']);
    check('claude hot switches to coolest bench account', sb.read('fixtures/calls.log').includes('use b@test'), sb.read('fixtures/calls.log'));
    check('claude switch journaled', sb.journal().some((e) => e.event === 'switch' && e.to === 'b@test' && (e.provider || 'claude') === 'claude'));
    check('claude switch updates active fixture state', sb.read('.claude/accounts/.active').trim() === 'b@test'
      && JSON.parse(sb.read('fixtures/usage.json')).active === 'b@test', r.stdout);
    const rJson = runCli(sb, ['--once', '--menubar', '--no-switch']);
    const snap = JSON.parse(rJson.stdout.trim().split('\n').filter(Boolean).pop());
    check('claude post-switch menubar snapshot renders the new active account', rJson.status === 0 && snap.claude.active === 'b@test', rJson.stdout + rJson.stderr);
  }

  // ── S3b: claude switch failure path
  {
    const sb = sandbox('s3b');
    sb.write('.claude.json', JSON.stringify({ oauthAccount: { emailAddress: 'a@test' } }));
    sb.write('.claude/accounts/a@test.json', claudeBlob());
    sb.write('fixtures/usage.json', JSON.stringify({ active: 'a@test', results: [
      { account: 'a@test', email: 'a@test', usage: claudeUsage(97, 30) },
      { account: 'failme@test', email: 'failme@test', usage: claudeUsage(10, 5) },
    ] }));
    runCli(sb, ['--once', '--plain']);
    check('failed claude switch journaled as switch-failed', sb.journal().some((e) => e.event === 'switch-failed' && e.to === 'failme@test'));
    check('failed claude switch notifies FAILED', sb.read('fixtures/notify.log').includes('FAILED'));
  }

  // ── S4: claude all-hot — nothing to switch to
  {
    const sb = sandbox('s4');
    sb.write('.claude.json', JSON.stringify({ oauthAccount: { emailAddress: 'a@test' } }));
    sb.write('.claude/accounts/a@test.json', claudeBlob());
    sb.write('fixtures/usage.json', JSON.stringify({ active: 'a@test', results: [
      { account: 'a@test', email: 'a@test', usage: claudeUsage(97, 30) },
    ] }));
    const r = runCli(sb, ['--once', '--plain']);
    check('claude all-hot holds and explains', r.stdout.includes('all accounts hot'), r.stdout);
    check('claude all-hot journaled once', sb.journal().filter((e) => e.event === 'all-hot').length === 1);
  }

  // ── S5: claude cooldown blocks the switch
  {
    const sb = sandbox('s5');
    standardWorld(sb, { claudeActiveUsed: 97 });
    sb.write('.claude/accounts/switch-journal.jsonl',
      JSON.stringify({ ts: new Date().toISOString(), provider: 'claude', event: 'switch', from: 'x', to: 'y' }) + '\n');
    const r = runCli(sb, ['--once', '--plain']);
    check('cooldown holds the claude switch', r.stdout.includes('cooldown') && !sb.read('fixtures/calls.log').includes('use '), r.stdout);
  }

  // ── S6: stale benched claude blobs refresh through the mock OAuth endpoint
  {
    const sb = sandbox('s6');
    standardWorld(sb);
    const past = Date.now() - 1000;
    sb.write('.claude/accounts/stale-good@test.json', claudeBlob({ refresh: 'rt-good', expiresAt: past }));
    sb.write('.claude/accounts/stale-bad@test.json', claudeBlob({ refresh: 'rt-bad', expiresAt: past }));
    sb.write('.claude/accounts/stale-net@test.json', claudeBlob({ refresh: 'rt-neterr', expiresAt: past }));
    sb.write('.claude/accounts/stale-none@test.json', '{"claudeAiOauth":{"accessToken":"at"}}');
    sb.write('fixtures/usage.json', JSON.stringify({ active: 'a@test', results: [
      { account: 'a@test', email: 'a@test', usage: claudeUsage(50, 30) },
      { account: 'stale-good@test', usage: claudeUsage(20, 10) },
      { account: 'stale-bad@test', usage: claudeUsage(20, 10) },
    ] }));
    const r = runCli(sb, ['--once', '--no-switch', '--plain']);
    const refreshed = sb.json('.claude/accounts/stale-good@test.json');
    check('stale blob refreshed atomically (new tokens)', refreshed && refreshed.claudeAiOauth.accessToken === 'at-new' && refreshed.claudeAiOauth.refreshToken === 'rt-good-2');
    check('refresh keeps a .bak of the previous blob', fs.existsSync(path.join(sb.home, '.claude/accounts/stale-good@test.json.bak')));
    check('400 refresh marks re-auth in the UI', r.stdout.includes('re-auth needed'), r.stdout);
    const net = sb.json('.claude/accounts/stale-net@test.json');
    check('network-failed refresh keeps the original blob', net && net.claudeAiOauth.accessToken === 'at-old');
  }

  // ── S7: active claude usage 401 → self-heal re-snapshot
  {
    const sb = sandbox('s7');
    standardWorld(sb);
    sb.write('.claude/accounts/a@test.json', claudeBlob({ refresh: 'rt-bad' }));
    sb.write('fixtures/usage.json', JSON.stringify({ active: 'a@test', results: [
      { account: 'a@test', email: 'a@test', usage: { ok: false, status: 401 } },
      { account: 'b@test', email: 'b@test', usage: claudeUsage(10, 5) },
    ] }));
    const r = runCli(sb, ['--once', '--plain']);
    check('401 active triggers keychain re-snapshot', sb.read('fixtures/calls.log').includes('save a@test'), sb.read('fixtures/calls.log'));
    check('snapshot journaled', sb.journal().some((e) => e.event === 'snapshot' && e.account === 'a@test'));
    check('active stale state rendered', r.stdout.includes('re-snapshotting'), r.stdout);
    check('active 401 does not mark live account reauth', !r.stdout.includes('re-auth needed'), r.stdout);
  }

  // ── S8: codex hot → switch + supervised session restart (synthetic ps table)
  {
    const sb = sandbox('s8');
    standardWorld(sb, { codexActiveTok: 'tok-97' });
    sb.write('.codex/accounts/cx-dead@test.json', codexBlob('cx-dead@test', 'tok-revoked'));
    const realTarget = sb.sh('realcodex', 'exit 0');
    sb.write('.codex/watch-shim.json', JSON.stringify({ binPath: realTarget, realTarget, version: 3 }));
    const supSleep = spawn('/bin/sleep', ['60']);
    const unsupSleep = spawn('/bin/sleep', ['60']);
    try {
      sb.sh('fakeps', `cat <<'EOF'
  100     1 node ${BIN} codex-supervise --
  ${supSleep.pid}   100 ${realTarget} exec task
  ${unsupSleep.pid}     1 node /x/node_modules/@openai/codex/bin/codex.js
EOF`);
      sb.sh('fakelsof', `echo "n/x/rollout-2026-06-12T10-00-00-${SID}.jsonl"`);
      const r = runCli(sb, ['--once', '--plain']);
      const auth = sb.json('.codex/auth.json');
      const email = auth && JSON.parse(Buffer.from(auth.tokens.id_token.split('.')[1], 'base64url').toString()).email;
      check('codex hot switches auth.json to coolest bench', email === 'cx-b@test', email);
      check('previous active snapshotted before swap', !!sb.json('.codex/accounts/cx-a@test.json'));
      check('codex switch journaled with reason', sb.journal().some((e) => e.provider === 'codex' && e.event === 'switch' && e.to === 'cx-b@test'));
      check('restart marker written with captured sid', sb.read(`.codex/watch-restarts/${supSleep.pid}`).trim() === SID);
      const dead = await new Promise((res) => { let n = 0; const iv = setInterval(() => {
        try { process.kill(supSleep.pid, 0); if (++n > 20) { clearInterval(iv); res(false); } }
        catch { clearInterval(iv); res(true); } }, 100); });
      check('supervised session SIGTERMed for resume', dead);
      let unsupAlive = true; try { process.kill(unsupSleep.pid, 0); } catch { unsupAlive = false; }
      check('pre-shim session left running, only counted', unsupAlive);
      check('session-restart journaled', sb.journal().some((e) => e.event === 'session-restart' && e.pid === supSleep.pid));
      check('revoked bench account rendered as re-login', r.stdout.includes('re-login needed') && r.stdout.includes('revive with'), r.stdout);
    } finally {
      for (const p of [supSleep, unsupSleep]) { try { p.kill('SIGKILL'); } catch {} }
    }
  }

  // ── S9/S10: codex all-hot and no-bench holds
  {
    const sb = sandbox('s9');
    standardWorld(sb, { codexActiveTok: 'tok-97' });
    sb.write('.codex/accounts/cx-b@test.json', codexBlob('cx-b@test', 'tok-96'));
    const r = runCli(sb, ['--once', '--plain']);
    check('codex all-hot holds and notifies', r.stdout.includes('all saved accounts look hot') && sb.read('fixtures/notify.log').includes('no usable fallback'), r.stdout);
    check('codex all-hot journaled', sb.journal().some((e) => e.provider === 'codex' && e.event === 'all-hot'));
  }
  {
    const sb = sandbox('s10');
    sb.write('fixtures/usage.json', JSON.stringify({ active: null, results: [] }));
    sb.write('.codex/auth.json', codexBlob('cx-a@test', 'tok-97'));
    const r = runCli(sb, ['--once', '--plain']);
    check('codex with no bench explains codex-save', r.stdout.includes('no other saved account'), r.stdout);
  }

  // ── S10b: codex monitor-only + cooldown holds
  {
    const sb = sandbox('s10b');
    standardWorld(sb, { codexActiveTok: 'tok-97' });
    const r = runCli(sb, ['--once', '--no-switch', '--plain']);
    check('codex monitor-only reports WOULD switch', r.stdout.includes('WOULD switch cx-a@test'), r.stdout);
    sb.write('.claude/accounts/switch-journal.jsonl',
      JSON.stringify({ ts: new Date().toISOString(), provider: 'codex', event: 'switch', from: 'x', to: 'y' }) + '\n');
    const r2 = runCli(sb, ['--once', '--plain']);
    check('codex cooldown holds the switch', r2.stdout.includes('cooldown'), r2.stdout);
  }

  // ── S11: codex subcommands
  {
    const sb = sandbox('s11');
    sb.write('.codex/auth.json', codexBlob('cx-a@test', 'tok-30'));
    let r = runCli(sb, ['codex-save']);
    check('codex-save snapshots active account', r.status === 0 && !!sb.json('.codex/accounts/cx-a@test.json'), r.stderr);
    sb.write('.codex/accounts/cx-b@test.json', codexBlob('cx-b@test', 'tok-10'));
    r = runCli(sb, ['codex-list']);
    check('codex-list marks live + saved', r.status === 0 && r.stdout.includes('* cx-a@test (live, saved)') && r.stdout.includes('cx-b@test (saved)'), r.stdout);
    r = runCli(sb, ['codex-use', 'cx-b@test']);
    const sw = sb.json('.codex/auth.json');
    check('codex-use swaps auth.json for new sessions', r.status === 0 && sw && sw.tokens.access_token === 'tok-10', r.stderr);
    check('manual codex-use journaled as manual', sb.journal().some((e) => e.reason === 'manual codex-use'));
    r = runCli(sb, ['codex-use', 'cx-b@test']);
    check('codex-use same account is a no-op', r.status === 0 && r.stdout.includes('already the active'));
    r = runCli(sb, ['codex-use']);
    check('codex-use without email errors', r.status === 1);
    r = runCli(sb, ['codex-use', 'nope@test']);
    check('codex-use unknown account errors', r.status === 1 && r.stderr.includes('no usable saved'));

    sb.write('.codex/auth.json', codexBlob('cx-a@test', 'tok-30'));
    sb.write('.codex/accounts/cx-b@test.json', codexBlob('cx-other@test', 'tok-other'));
    r = runCli(sb, ['codex-use', 'cx-b@test']);
    check('codex-use refuses saved file whose identity mismatches its name', r.status === 1
      && sb.json('.codex/auth.json').tokens.access_token === 'tok-30', r.stdout + r.stderr);
    const sbEmpty = sandbox('s11b');
    r = runCli(sbEmpty, ['codex-save']);
    check('codex-save without login errors', r.status === 1);
    r = runCli(sbEmpty, ['codex-list']);
    check('codex-list with nothing found', r.status === 0 && r.stdout.includes('No codex accounts found'));
  }

  // ── S12: codex-ensure — the launch-time gate (regression test for the
  //         dead-probe bug: ensure must live-probe, then switch)
  {
    const sb = sandbox('s12');
    sb.write('.codex/auth.json', codexBlob('cx-a@test', 'tok-97'));
    sb.write('.codex/accounts/cx-b@test.json', codexBlob('cx-b@test', 'tok-10'));
    let r = runCli(sb, ['codex-ensure']);
    check('ensure without fresh usage exits quietly', r.status === 0 && !sb.json('.codex/auth.json').tokens.access_token.includes('tok-10'));
    writeRollout(sb, { used: 97, extraSpark: true });
    r = runCli(sb, ['codex-ensure']);
    const sw = sb.json('.codex/auth.json');
    check('hot launch ensure switches before start (bug fix)', r.status === 0 && sw && sw.tokens.access_token === 'tok-10', r.stderr);
    check('ensure switch journaled as launch ensure', sb.journal().some((e) => String(e.reason).includes('launch ensure')));
    check('ensure announces on stderr without --quiet', r.stderr.includes('codex account switched'), r.stderr);
    const sbRestart = sandbox('s12-restart');
    sbRestart.write('.codex/auth.json', codexBlob('cx-a@test', 'tok-97'));
    sbRestart.write('.codex/accounts/cx-b@test.json', codexBlob('cx-b@test', 'tok-10'));
    writeRollout(sbRestart, { used: 97, extraSpark: true });
    const realTarget = sbRestart.sh('realcodex', 'exit 0');
    sbRestart.write('.codex/watch-shim.json', JSON.stringify({ binPath: realTarget, realTarget, version: 3 }));
    const supSleep = spawn('/bin/sleep', ['60']);
    try {
      sbRestart.sh('fakeps', `cat <<'EOF'
  100     1 node ${BIN} codex-supervise --
  ${supSleep.pid}   100 ${realTarget} exec task
EOF`);
      sbRestart.sh('fakelsof', `echo "n/x/rollout-2026-06-12T10-00-00-${SID}.jsonl"`);
      r = runCli(sbRestart, ['codex-ensure', '--quiet']);
      const dead = await new Promise((res) => { let n = 0; const iv = setInterval(() => {
        try { process.kill(supSleep.pid, 0); if (++n > 20) { clearInterval(iv); res(false); } }
        catch { clearInterval(iv); res(true); } }, 100); });
      check('launch ensure restarts already-running supervised sessions after switching', r.status === 0
        && sbRestart.json('.codex/auth.json').tokens.access_token === 'tok-10'
        && sbRestart.read(`.codex/watch-restarts/${supSleep.pid}`).trim() === SID
        && dead, r.stdout + r.stderr);
      check('launch ensure restart is journaled', sbRestart.journal().some((e) => e.event === 'session-restart' && e.pid === supSleep.pid));
    } finally {
      try { supSleep.kill('SIGKILL'); } catch {}
    }
    // cooldown: journal now has a fresh switch → second hot ensure holds
    sb.write('.codex/auth.json', codexBlob('cx-a@test', 'tok-97'));
    r = runCli(sb, ['codex-ensure', '--quiet']);
    check('ensure respects cooldown', r.status === 0 && sb.json('.codex/auth.json').tokens.access_token === 'tok-97');
    // stale rollout → not fresh → no switch
    const sb2 = sandbox('s12b');
    sb2.write('.codex/auth.json', codexBlob('cx-a@test', 'tok-97'));
    sb2.write('.codex/accounts/cx-b@test.json', codexBlob('cx-b@test', 'tok-10'));
    writeRollout(sb2, { used: 97, ageMs: 2 * 3600_000 });
    r = runCli(sb2, ['codex-ensure']);
    check('stale usage never drives an ensure switch', r.status === 0 && sb2.json('.codex/auth.json').tokens.access_token === 'tok-97');
  }

  // ── S13: codex-supervise — marker restart, resume args, exit mirroring
  {
    const sb = sandbox('s13');
    const real = sb.sh('realcodex', `case "$*" in
  *resume*) echo "RESUMED:$*"; exit 0;;
esac
mkdir -p "$HOME/.codex/watch-restarts"
echo "${SID}" > "$HOME/.codex/watch-restarts/$$"
exit 7`);
    sb.write('.codex/watch-shim.json', JSON.stringify({ binPath: real, realTarget: real, version: 3 }));
    let r = runCli(sb, ['codex-supervise', '--', 'exec', 'do the thing']);
    check('supervisor resumes the captured session', r.status === 0 && r.stdout.includes(`RESUMED:exec resume ${SID}`), r.stdout + r.stderr);
    check('supervisor narrates the resume on stderr', r.stderr.includes('resuming codex session'), r.stderr);
    const real2 = sb.sh('realcodex2', 'exit 3');
    r = runCli(sb, ['codex-supervise', '--'], { AI_CLI_WATCH_REAL: real2 });
    check('supervisor mirrors a normal exit code', r.status === 3, String(r.status));
    const sbNoState = sandbox('s13b');
    r = runCli(sbNoState, ['codex-supervise', '--']);
    check('supervisor without shim state fails loudly (127)', r.status === 127 && r.stderr.includes('shim state missing'), r.stderr);
    // empty-sid marker → relaunch with original args (exec-mode fallback)
    const sb3 = sandbox('s13c');
    const real3 = sb3.sh('realcodex', `if [ ! -f "$HOME/fixtures/.restarted" ]; then
  touch "$HOME/fixtures/.restarted"
  mkdir -p "$HOME/.codex/watch-restarts"
  : > "$HOME/.codex/watch-restarts/$$"
  exit 7
fi
echo "RELAUNCHED:$*"; exit 0`);
    sb3.write('.codex/watch-shim.json', JSON.stringify({ binPath: real3, realTarget: real3, version: 3 }));
    r = runCli(sb3, ['codex-supervise', '--', 'exec', 'task']);
    check('empty-sid marker relaunches original args', r.status === 0 && r.stdout.includes('RELAUNCHED:exec task'), r.stdout + r.stderr);
  }

  // ── S14: codex-shim install/status/uninstall full cycle on a fake binary
  {
    const sb = sandbox('s14');
    const stock = sb.sh('stockcodex', 'echo stock');
    const env = { AI_ACCT_CODEX_BIN: stock };
    let r = runCli(sb, ['codex-shim', 'status'], env);
    check('shim status: not installed on stock binary', r.status === 0 && r.stdout.includes('not installed'), r.stdout);
    r = runCli(sb, ['codex-shim', 'install'], env);
    const installed = fs.readFileSync(stock, 'utf8');
    check('shim install wraps the binary in place', r.status === 0 && installed.includes('ai-acct-autopilot codex shim') && installed.includes('codex-supervise'), r.stderr);
    check('shim install records realTarget state', (sb.json('.codex/watch-shim.json') || {}).version === 3);
    r = runCli(sb, ['codex-shim', 'status'], env);
    check('shim status: INSTALLED after install', r.stdout.includes('INSTALLED'), r.stdout);
    fs.writeFileSync(stock, `#!/bin/sh
# ai-acct-autopilot codex shim v3 (node supervisor)
exec node "/old/ai-acct-autopilot.js" codex-supervise -- "$@"
`, { mode: 0o755 });
    r = runCli(sb, ['codex-shim', 'status'], env);
    check('shim status: OUTDATED when v3 points at an old engine', r.status === 0 && r.stdout.includes('OUTDATED') && r.stdout.includes('/old/ai-acct-autopilot.js'), r.stdout);
    r = runCli(sb, ['codex-shim', 'install'], env);
    const updated = fs.readFileSync(stock, 'utf8');
    check('shim install updates an outdated v3 wrapper to the current engine', r.status === 0
      && updated.includes(`exec node "${BIN}" codex-supervise`)
      && !(updated.includes('/old/ai-acct-autopilot.js'))
      && !!(sb.json('.codex/watch-shim.json') || {}).updatedAt, r.stdout + r.stderr);
    r = runCli(sb, ['codex-shim', 'install'], env);
    check('reinstall is an idempotent no-op', r.status === 0 && r.stdout.includes('already installed'), r.stdout);
    check('real-file codex moved aside, never self-targeted', fs.readFileSync(`${stock}.real`, 'utf8').includes('echo stock')
      && (sb.json('.codex/watch-shim.json') || {}).realTarget === `${stock}.real`);
    r = runCli(sb, ['codex-shim', 'uninstall'], env);
    check('uninstall restores the original real-file binary', r.status === 0 && !fs.lstatSync(stock).isSymbolicLink()
      && fs.readFileSync(stock, 'utf8').includes('echo stock'), r.stdout);
    r = runCli(sb, ['codex-shim', 'uninstall'], env);
    check('double uninstall is safe', r.status === 0 && r.stdout.includes('not installed'), r.stdout + r.stderr);
    // npm-shaped install: codex on PATH is a symlink to the real launcher
    const realLauncher = sb.sh('actual-codex-launcher', 'echo launcher');
    const link = path.join(sb.bin, 'codexlink');
    fs.symlinkSync(realLauncher, link);
    r = runCli(sb, ['codex-shim', 'install'], { AI_ACCT_CODEX_BIN: link });
    check('symlink install resolves the real launcher as target', r.status === 0
      && (sb.json('.codex/watch-shim.json') || {}).realTarget === fs.realpathSync(realLauncher), r.stderr || JSON.stringify(sb.json('.codex/watch-shim.json')));
    r = runCli(sb, ['codex-shim', 'uninstall'], { AI_ACCT_CODEX_BIN: link });
    check('symlink uninstall restores the symlink', r.status === 0 && fs.lstatSync(link).isSymbolicLink(), r.stdout);
    // legacy shim upgrades in place using recorded state
    const sb2 = sandbox('s14b');
    const legacy = sb2.sh('legacycodex', '# ai-cli-watch codex shim v2\nexit 0');
    const realT = sb2.sh('therealone', 'exit 0');
    sb2.write('.codex/watch-shim.json', JSON.stringify({ binPath: legacy, realTarget: realT, version: 2 }));
    r = runCli(sb2, ['codex-shim', 'install'], { AI_ACCT_CODEX_BIN: legacy });
    check('legacy shim upgrades to v3 in place', r.status === 0 && fs.readFileSync(legacy, 'utf8').includes('codex shim v3'), r.stdout + r.stderr);
    // shim present but state lost → refuses install
    const sb3 = sandbox('s14c');
    const orphan = sb3.sh('orphan', '# ai-acct-autopilot codex shim v2\nexit 0');
    r = runCli(sb3, ['codex-shim', 'install'], { AI_ACCT_CODEX_BIN: orphan });
    check('orphaned shim without state refuses install', r.status === 1 && r.stderr.includes('uninstall first'), r.stderr);
    r = runCli(sb3, ['codex-shim', 'install'], { AI_ACCT_CODEX_BIN: path.join(sb3.home, 'missing') });
    check('no codex binary found errors', r.status === 1 && r.stderr.includes('not found'));
    r = runCli(sb3, ['codex-shim', 'wat'], { AI_ACCT_CODEX_BIN: orphan });
    check('unknown shim subcommand prints usage', r.status === 1 && r.stderr.includes('usage:'));
  }

  // ── S15: degraded worlds — no codex login / claude-acct failure
  {
    const sb = sandbox('s15');
    sb.write('fixtures/usage.json', JSON.stringify({ active: null, results: [] }));
    let r = runCli(sb, ['--once', '--no-switch', '--plain']);
    check('no codex login rendered as guidance', r.stdout.includes('no codex chatgpt login found'), r.stdout);
    const sb2 = sandbox('s15b');
    sb2.sh('claude-acct', 'exit 1');
    r = runCli(sb2, ['--once', '--no-switch', '--plain']);
    check('claude-acct failure rendered, tick survives', r.status === 0 && r.stdout.includes('claude-acct usage failed'), r.stdout);
  }

  // ── S16: the shim-missing amber nag, live in a real render
  {
    const sb = sandbox('s16');
    standardWorld(sb);
    const stock = sb.sh('stockcodex', 'echo stock');
    const r = runCli(sb, ['--once', '--no-switch', '--plain'], { AI_ACCT_CODEX_BIN: stock });
    check('stock codex binary draws the shim nag', r.stdout.includes('shim not installed') && r.stdout.includes('codex-shim install'), r.stdout);
    const r2 = runCli(sb, ['--once', '--no-switch', '--plain'], { AI_ACCT_CODEX_BIN: path.join(sb.home, 'nope') });
    check('unknown codex location stays quiet', !r2.stdout.includes('shim not installed'), r2.stdout);
  }

  // ── S17: codex-add — isolated-home login import (fake login binary)
  {
    const sb = sandbox('s17');
    const fakeLogin = sb.sh('fakelogin', `cat > "$CODEX_HOME/auth.json" <<EOF
{"tokens":{"id_token":"${jwt('new@cx')}","access_token":"tok-20","refresh_token":"rt-new"}}
EOF
exit 0`);
    sb.write('.codex/watch-shim.json', JSON.stringify({ binPath: fakeLogin, realTarget: fakeLogin, version: 3 }));
    let r = runCli(sb, ['codex-add']);
    check('codex-add imports the isolated login', r.status === 0 && !!sb.json('.codex/accounts/new@cx.json') && r.stdout.includes("Added 'new@cx'"), r.stdout + r.stderr);
    const sbApp = sandbox('s17d');
    const fakeLoginApp = sbApp.sh('fakelogin', `cat > "$CODEX_HOME/auth.json" <<EOF
{"tokens":{"id_token":"${jwt('new@cx')}","access_token":"tok-20","refresh_token":"rt-new"}}
EOF
exit 0`);
    sbApp.write('.codex/watch-shim.json', JSON.stringify({ binPath: fakeLoginApp, realTarget: fakeLoginApp, version: 3 }));
    r = runCli(sbApp, ['app-action', 'codex-add', '--json']);
    const appAdded = JSON.parse(r.stdout);
    check('app-action codex-add returns imported email for optimistic UI', r.status === 0 && appAdded.ok
      && appAdded.data && appAdded.data.email === 'new@cx'
      && !!sbApp.json('.codex/accounts/new@cx.json'), r.stdout + r.stderr);
    const sb2 = sandbox('s17b');
    const badLogin = sb2.sh('badlogin', 'exit 1');
    sb2.write('.codex/watch-shim.json', JSON.stringify({ binPath: badLogin, realTarget: badLogin, version: 3 }));
    r = runCli(sb2, ['codex-add']);
    check('failed login imports nothing', r.status === 1 && r.stderr.includes('nothing imported'), r.stderr);
    const sb3 = sandbox('s17c');
    r = runCli(sb3, ['codex-add']);
    check('codex-add without shim state errors', r.status === 1 && r.stderr.includes('shim state missing'));
  }

  // ── S18: interactive loop — ANSI render path + bounded clean exit
  {
    const sb = sandbox('s18');
    standardWorld(sb);
    const env = {
      HOME: sb.home, PATH: `${sb.bin}:${NODE_DIR}:/usr/bin:/bin:/usr/sbin:/sbin`,
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      AI_ACCT_OAUTH_URL: `https://127.0.0.1:${PORT}/oauth`, AI_ACCT_WHAM_URL: `https://127.0.0.1:${PORT}/wham`,
      AI_ACCT_PS_BIN: sb.fakePs, AI_ACCT_LSOF_BIN: sb.fakeLsof, TERM: 'xterm',
      AI_ACCT_FORCE_ANSI: '1', AI_ACCT_EXIT_AFTER_MS: '4000',
      ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
    };
    const child = spawn(process.execPath, [BIN, '--interval', '15', '--no-switch'], { env });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    const code = await new Promise((r) => { child.on('exit', (c) => r(c)); setTimeout(() => { child.kill('SIGKILL'); r(-1); }, 30_000); });
    check('interactive loop renders with ANSI and exits clean', code === 0 && out.includes('AI CLI Accounts') && out.includes('\x1b['), `exit=${code} out=${out.slice(0, 120)}`);
  }

  // ── S19: --menubar JSON feed — NDJSON per tick, SIGUSR2 = refresh now
  {
    const sb = sandbox('s19');
    standardWorld(sb);
    const env = {
      HOME: sb.home, PATH: `${sb.bin}:${NODE_DIR}:/usr/bin:/bin:/usr/sbin:/sbin`,
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      AI_ACCT_OAUTH_URL: `https://127.0.0.1:${PORT}/oauth`, AI_ACCT_WHAM_URL: `https://127.0.0.1:${PORT}/wham`,
      AI_ACCT_PS_BIN: sb.fakePs, AI_ACCT_LSOF_BIN: sb.fakeLsof, TERM: 'dumb',
      AI_ACCT_EXIT_AFTER_MS: '8000',
      // pin the shim probe to a missing path — the host machine's real codex
      // install state must not decide whether the snapshot carries an alert
      AI_ACCT_CODEX_BIN: path.join(sb.home, 'no-codex-here'),
      ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
    };
    // interval 300s: within the 8s window the ONLY extra ticks can come from
    // the startup stats rerender and our SIGUSR2 poke.
    const child = spawn(process.execPath, [BIN, '--menubar', '--interval', '300', '--no-switch'], { env });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    const lineCount = () => out.split('\n').filter(Boolean).length;
    const waitFor = (cond, ms) => new Promise((res) => {
      const t0 = Date.now();
      const iv = setInterval(() => { if (cond() || Date.now() - t0 > ms) { clearInterval(iv); res(); } }, 50);
    });
    await waitFor(() => lineCount() >= 1, 15_000);
    await new Promise((r) => setTimeout(r, 1500));   // let the stats rerender land
    const before = lineCount();
    child.kill('SIGUSR2');
    const code = await new Promise((r) => { child.on('exit', (c) => r(c)); setTimeout(() => { child.kill('SIGKILL'); r(-1); }, 30_000); });
    const snaps = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } });
    check('menubar feed: clean exit, every line is JSON, no ANSI', code === 0 && snaps.length > 0 && snaps.every(Boolean) && !out.includes('\x1b['), out.slice(0, 200));
    const s = snaps[0];
    check('menubar feed: claude accounts mapped with % left', !!s && s.claude.active === 'a@test'
      && s.claude.accounts.some((a) => a.name === 'b@test' && a.percentLeft === 90 && !a.active), JSON.stringify(s && s.claude));
    check('menubar feed: codex accounts probed and mapped', !!s && s.codex.active === 'cx-a@test'
      && s.codex.accounts.some((a) => a.email === 'cx-b@test' && a.percentLeft === 90 && a.saved), JSON.stringify(s && s.codex));
    check('menubar feed: usage rows carry reset timestamps', !!s && s.claude.accounts[0].rows.every((r) => r.resetsAt), JSON.stringify(s && s.claude.accounts[0]));
    check('menubar feed: mode/threshold/interval surfaced', !!s && s.mode === 'monitor' && s.threshold === 5 && s.interval === 300);
    check('menubar feed: SIGUSR2 forces an immediate tick', snaps.length > before, `before=${before} after=${snaps.length}`);
    check('menubar feed: healthy world → attention ok', !!s && s.attention === 'ok' && s.alerts.length === 0, JSON.stringify(s && s.alerts));
  }

  // ── S19a: refresh requested during an in-flight tick is queued, not lost
  {
    const sb = sandbox('s19a');
    standardWorld(sb, { codexActiveTok: 'tok-88' });
    const env = {
      HOME: sb.home, PATH: `${sb.bin}:${NODE_DIR}:/usr/bin:/bin:/usr/sbin:/sbin`,
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      AI_ACCT_OAUTH_URL: `https://127.0.0.1:${PORT}/oauth`, AI_ACCT_WHAM_URL: `https://127.0.0.1:${PORT}/wham`,
      AI_ACCT_PS_BIN: sb.fakePs, AI_ACCT_LSOF_BIN: sb.fakeLsof, AI_ACCT_PGREP_BIN: sb.fakePgrep, TERM: 'dumb',
      AI_ACCT_EXIT_AFTER_MS: '8000',
      AI_ACCT_CODEX_BIN: path.join(sb.home, 'no-codex-here'),
      ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
    };
    const child = spawn(process.execPath, [BIN, '--menubar', '--interval', '300', '--no-switch'], { env });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    await new Promise((r) => setTimeout(r, 1000));
    child.kill('SIGUSR2');
    const code = await new Promise((r) => { child.on('exit', (c) => r(c)); setTimeout(() => { child.kill('SIGKILL'); r(-1); }, 12_000); });
    const snaps = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } });
    check('menubar feed: SIGUSR2 during in-flight tick queues another snapshot', code === 0 && snaps.filter(Boolean).length >= 2,
      `code=${code} count=${snaps.filter(Boolean).length} out=${out.slice(0, 200)}`);
  }

  // ── S19b: native app JSON contract used by the Manage Accounts surface
  {
    const sb = sandbox('s19b');
    standardWorld(sb);
    const stock = sb.sh('stockcodex', 'echo stock');
    let r = runCli(sb, ['app-state', '--json'], { AI_ACCT_CODEX_BIN: stock });
    const state = JSON.parse(r.stdout);
    check('app-state emits readiness + shim contract', r.status === 0 && state.readiness.status === 'amber'
      && state.readiness.items.some((i) => i.action === 'codex-save')
      && state.shim.status === 'missing' && state.shim.action === 'codex-shim-install', r.stdout + r.stderr);
    check('app-state shares menubar account mapping', state.claude.active === 'a@test' && state.codex.active === 'cx-a@test'
      && state.codex.accounts.some((a) => a.email === 'cx-b@test' && a.saved), JSON.stringify(state));
    const claudeUnavailable = state.claude.accounts.find((a) => a.name === 'c@test');
    check('app-state surfaces Claude usage failure reason', !!claudeUnavailable
      && claudeUnavailable.usageStatus === 500
      && /HTTP 500/.test(claudeUnavailable.usageMessage || ''),
      JSON.stringify(claudeUnavailable));
    const sbRefetch = sandbox('s19b-refetch-failure');
    standardWorld(sbRefetch);
    sbRefetch.write('fixtures/usage-first.json', JSON.stringify({ active: 'a@test', results: [
      { account: 'a@test', email: 'a@test', subscriptionType: 'max', usage: claudeUsage(40, 20) },
      { account: 'b@test', email: 'b@test', usage: { ok: false, status: 401 } },
    ] }));
    sbRefetch.sh('claude-acct', `case "$1" in
  usage) if [ -f "${sbRefetch.home}/fixtures/usage-count" ]; then n=$(cat "${sbRefetch.home}/fixtures/usage-count"); else n=0; fi; n=$((n+1)); echo "$n" > "${sbRefetch.home}/fixtures/usage-count"; [ "$n" = "1" ] && cat "${sbRefetch.home}/fixtures/usage-first.json" || printf '{broken-json'; exit 0;;
  save) echo "save $2" >> "${sbRefetch.home}/fixtures/calls.log"; exit 0;;
esac
exit 0`);
    const refetchRun = runCli(sbRefetch, ['app-state', '--json'], { AI_ACCT_CODEX_BIN: stock });
    const refetchState = JSON.parse(refetchRun.stdout);
    const refetchAccount = refetchState.claude.accounts.find((a) => a.name === 'b@test');
    check('app-state keeps first Claude report when post-refresh refetch fails', refetchRun.status === 0
      && refetchState.claude.ok === true
      && refetchState.claude.accounts.length === 2
      && refetchAccount
      && refetchAccount.usageStatus === 401
      && /refreshing saved OAuth credentials/.test(refetchAccount.usageMessage || ''),
      refetchRun.stdout + refetchRun.stderr);

    const sbParallel = sandbox('s19b-parallel-codex-probes');
    standardWorld(sbParallel, { codexActiveTok: 'tok-88' });
    sbParallel.write('.codex/accounts/cx-b@test.json', codexBlob('cx-b@test', 'tok-88'));
    sbParallel.write('.codex/accounts/cx-c@test.json', codexBlob('cx-c@test', 'tok-88'));
    const parallelStarted = Date.now();
    const parallelRun = runCli(sbParallel, ['app-state', '--json'], { AI_ACCT_CODEX_BIN: stock });
    const parallelMs = Date.now() - parallelStarted;
    const parallelState = JSON.parse(parallelRun.stdout);
    check('app-state probes Codex accounts concurrently for responsive menu refresh', parallelRun.status === 0
      && parallelMs < 5000
      && parallelState.codex.accounts.length === 3
      && parallelState.codex.accounts.every((a) => a.percentLeft === 12),
      `ms=${parallelMs} stdout=${parallelRun.stdout} stderr=${parallelRun.stderr}`);


    const sbUpdate = sandbox('s19b-update');
    standardWorld(sbUpdate);
    r = runCli(sbUpdate, ['app-state', '--json'], {
      AI_ACCT_CODEX_BIN: stock,
      AI_ACCT_DISABLE_UPDATE_CHECK: '0',
      AI_ACCT_UPDATE_CACHE_MS: '0',
      AI_ACCT_UPDATE_URL: `https://127.0.0.1:${PORT}/release`,
    });
    const updateState = JSON.parse(r.stdout);
    check('app-state exposes newer GitHub release as update alert', r.status === 0
      && updateState.update && updateState.update.available === true
      && updateState.update.latestVersion === '9.8.7'
      && updateState.update.downloadUrl.endsWith('/AI-Acct-Autopilot-9.8.7.dmg')
      && updateState.alerts.some((a) => a.action === 'update' && a.text.includes('9.8.7')), r.stdout + r.stderr);

    const sbStale = sandbox('s19b-stale-claude-active');
    standardWorld(sbStale);
    sbStale.write('.claude/accounts/.active', 'b@test\n');
    sbStale.write('fixtures/usage.json', JSON.stringify({ active: 'a@test', selected: 'b@test', results: [
      { account: 'a@test', email: 'a@test', selected: false, active: true, subscriptionType: 'max', usage: claudeUsage(50, 30) },
      { account: 'b@test', email: 'b@test', selected: true, active: false, subscriptionType: 'max', usage: claudeUsage(10, 5) },
    ] }));
    const staleStateRun = runCli(sbStale, ['app-state', '--json'], { AI_ACCT_CODEX_BIN: stock });
    const staleState = JSON.parse(staleStateRun.stdout);
    check('app-state prefers selected Claude switch marker over stale profile active', staleStateRun.status === 0
      && staleState.claude.active === 'b@test'
      && staleState.claude.accounts.some((a) => a.name === 'b@test' && a.active)
      && staleState.claude.accounts.some((a) => a.name === 'a@test' && !a.active), staleStateRun.stdout + staleStateRun.stderr);

    r = runCli(sb, ['app-action', 'codex-save', '--json']);
    let action = JSON.parse(r.stdout);
    check('app-action codex-save snapshots active account as JSON', r.status === 0 && action.ok && action.needsRefresh
      && !!sb.json('.codex/accounts/cx-a@test.json'), r.stdout + r.stderr);

    const realTarget = sb.sh('realcodex', 'exit 0');
    sb.write('.codex/watch-shim.json', JSON.stringify({ binPath: realTarget, realTarget, version: 3 }));
    const supSleep = spawn('/bin/sleep', ['60']);
    const unsupSleep = spawn('/bin/sleep', ['60']);
    try {
      sb.sh('fakeps', `cat <<'EOF'
  100     1 node ${BIN} codex-supervise --
  ${supSleep.pid}   100 ${realTarget} exec task
  ${unsupSleep.pid}     1 node /x/node_modules/@openai/codex/bin/codex.js
EOF`);
      sb.sh('fakelsof', `echo "n/x/rollout-2026-06-12T10-00-00-${SID}.jsonl"`);
      r = runCli(sb, ['app-action', 'codex-use', 'cx-b@test', '--json']);
      action = JSON.parse(r.stdout);
      check('app-action codex-use swaps through Node contract', r.status === 0 && action.ok
        && sb.json('.codex/auth.json').tokens.access_token === 'tok-10'
        && sb.journal().some((e) => e.provider === 'codex' && e.reason === 'manual app-action'), r.stdout + r.stderr);
      check('app-action codex-use reports restarted and pre-shim sessions', action.data
        && action.data.restarted === 1 && action.data.unsupervised === 1
        && action.userActionRequired && action.message.includes('manual restart'), r.stdout + r.stderr);
    } finally {
      for (const p of [supSleep, unsupSleep]) { try { p.kill('SIGKILL'); } catch {} }
    }

    r = runCli(sb, ['app-action', 'claude-use', 'b@test', '--json']);
    action = JSON.parse(r.stdout);
    check('app-action claude-use goes through claude-acct with JSON result', r.status === 0 && action.ok
      && sb.read('fixtures/calls.log').includes('use b@test')
      && sb.journal().some((e) => e.provider === 'claude' && e.event === 'switch'
        && e.from === 'a@test' && e.to === 'b@test' && e.reason === 'manual app-action'), r.stdout + r.stderr);

    sb.write('fixtures/calls.log', '');
    sb.write('fixtures/usage.json', JSON.stringify({ active: 'a@test', results: [
      { account: 'a@test', email: 'a@test', subscriptionType: 'max', usage: claudeUsage(97, 30) },
      { account: 'b@test', email: 'b@test', usage: claudeUsage(10, 5) },
    ] }));
    r = runCli(sb, ['--once', '--plain']);
    check('app-action claude-use journal creates cooldown for autopilot', r.status === 0
      && r.stdout.includes('cooldown') && !sb.read('fixtures/calls.log').includes('use '), r.stdout + r.stderr);

    sb.write('.claude/accounts/b@test.meta', 'email=b@test\n');
    sb.write('.claude/accounts/b@test.oauthAccount.json', JSON.stringify({ emailAddress: 'b@test' }));
    sb.write('.claude/accounts/b@test.oat', 'pin-token');
    sb.write('.claude/accounts/b@test.json.bak', claudeBlob({ refresh: 'rt-bak' }));
    sb.write('.claude/accounts/unsaved-live-7.json', claudeBlob());
    sb.write('.claude/accounts/usage-history.json', '{"keep":true}');
    sb.write('.claude/accounts/switch-journal.jsonl', '{"event":"seed"}\n');
    sb.write('.claude/accounts/.active', 'a@test\n');
    r = runCli(sb, ['app-action', 'claude-remove', 'b@test', '--json']);
    action = JSON.parse(r.stdout);
    check('app-action claude-remove deletes only saved Claude account artifacts', r.status === 0 && action.ok
      && !fs.existsSync(path.join(sb.home, '.claude/accounts/b@test.json'))
      && !fs.existsSync(path.join(sb.home, '.claude/accounts/b@test.json.bak'))
      && !fs.existsSync(path.join(sb.home, '.claude/accounts/b@test.meta'))
      && !fs.existsSync(path.join(sb.home, '.claude/accounts/b@test.oauthAccount.json'))
      && !fs.existsSync(path.join(sb.home, '.claude/accounts/b@test.oat'))
      && fs.existsSync(path.join(sb.home, '.claude/accounts/a@test.json'))
      && fs.existsSync(path.join(sb.home, '.claude/accounts/unsaved-live-7.json'))
      && sb.read('.claude/accounts/.active').trim() === 'a@test'
      && sb.read('.claude/accounts/usage-history.json') === '{"keep":true}'
      && fs.existsSync(path.join(sb.home, '.claude.json')), r.stdout + r.stderr);

    r = runCli(sb, ['app-action', 'claude-remove', 'a@test', '--json']);
    action = JSON.parse(r.stdout);
    check('app-action claude-remove refuses the active Claude account', r.status === 1 && !action.ok
      && action.errorCode === 'active-account'
      && fs.existsSync(path.join(sb.home, '.claude/accounts/a@test.json')), r.stdout + r.stderr);

    fs.rmSync(path.join(sb.home, '.claude/accounts/.active'), { force: true });
    fs.rmSync(path.join(sb.home, '.claude/accounts/a@test.meta'), { force: true });
    r = runCli(sb, ['app-action', 'claude-remove', 'a@test', '--json']);
    action = JSON.parse(r.stdout);
    check('app-action claude-remove refuses live Claude email without .active or .meta', r.status === 1 && !action.ok
      && action.errorCode === 'active-account'
      && fs.existsSync(path.join(sb.home, '.claude/accounts/a@test.json')), r.stdout + r.stderr);

    r = runCli(sb, ['app-action', 'claude-remove', 'unsaved-live-7', '--json']);
    action = JSON.parse(r.stdout);
    check('app-action claude-remove refuses recovery snapshots', r.status === 1 && !action.ok
      && action.errorCode === 'recovery-account'
      && fs.existsSync(path.join(sb.home, '.claude/accounts/unsaved-live-7.json')), r.stdout + r.stderr);

    sb.write('.codex/accounts/cx-c@test.json', codexBlob('cx-c@test', 'tok-20'));
    sb.write('.codex/watch-shim.json', '{"keep":true}');
    sb.write('.codex/watch-restarts/123', 'sid');
    r = runCli(sb, ['app-action', 'codex-remove', 'cx-c@test', '--json']);
    action = JSON.parse(r.stdout);
    check('app-action codex-remove deletes a non-active saved Codex account only', r.status === 0 && action.ok
      && !fs.existsSync(path.join(sb.home, '.codex/accounts/cx-c@test.json'))
      && fs.existsSync(path.join(sb.home, '.codex/auth.json'))
      && fs.existsSync(path.join(sb.home, '.codex/accounts/cx-a@test.json'))
      && sb.read('.codex/watch-shim.json') === '{"keep":true}'
      && sb.read('.codex/watch-restarts/123') === 'sid', r.stdout + r.stderr);

    sb.write('.codex/accounts/cx-b@test.json.bak', codexBlob('cx-b@test', 'tok-bak'));
    r = runCli(sb, ['app-action', 'codex-remove', 'cx-b@test', '--json']);
    action = JSON.parse(r.stdout);
    check('app-action codex-remove refuses the active Codex account', r.status === 1 && !action.ok
      && action.errorCode === 'active-account'
      && fs.existsSync(path.join(sb.home, '.codex/accounts/cx-b@test.json'))
      && fs.existsSync(path.join(sb.home, '.codex/accounts/cx-b@test.json.bak'))
      && sb.json('.codex/auth.json').tokens.access_token === 'tok-10', r.stdout + r.stderr);

    r = runCli(sb, ['app-action', 'codex-remove', 'missing@test', '--json']);
    action = JSON.parse(r.stdout);
    check('app-action codex-remove missing account is structured failure', r.status === 1 && !action.ok
      && action.errorCode === 'not-found'
      && fs.existsSync(path.join(sb.home, '.codex/auth.json')), r.stdout + r.stderr);

    sb.write('fixtures/usage.json', JSON.stringify({ active: 'a@test', results: [
      { account: 'a@test', email: 'a@test', subscriptionType: 'max', usage: claudeUsage(50, 30) },
      { account: 'unsaved-live-7', usage: claudeUsage(1, 1) },
    ] }));
    r = runCli(sb, ['app-state', '--json'], { AI_ACCT_CODEX_BIN: stock });
    const stateAfterRemove = JSON.parse(r.stdout);
    check('app-state after removal omits removed saved accounts', r.status === 0
      && !stateAfterRemove.claude.accounts.some((a) => a.name === 'b@test')
      && !stateAfterRemove.codex.accounts.some((a) => a.email === 'cx-c@test')
      && stateAfterRemove.codex.accounts.some((a) => a.email === 'cx-b@test' && a.active && a.saved), r.stdout + r.stderr);

    r = runCli(sb, ['app-action', 'claude-use', '--json']);
    action = JSON.parse(r.stdout);
    check('app-action strips --json before required value validation', r.status === 1 && !action.ok
      && action.errorCode === 'missing-account', r.stdout + r.stderr);

    r = runCli(sb, ['app-action', 'unknown-thing', '--json']);
    action = JSON.parse(r.stdout);
    check('app-action unknown action fails as structured JSON', r.status === 1 && !action.ok
      && action.errorCode === 'unknown-action', r.stdout + r.stderr);

    r = runCli(sb, ['app-diagnose', '--json'], { AI_ACCT_CODEX_BIN: stock });
    const diag = JSON.parse(r.stdout);
    check('app-diagnose emits support JSON without starting dashboard', r.status === 0 && diag.ok
      && diag.node.path === process.execPath && diag.codex.authPresent === true && diag.menubar.app, r.stdout + r.stderr);

    const packagedApp = path.join(sb.home, 'Downloads', 'AI Acct Autopilot.app');
    const packagedEngine = path.join(packagedApp, 'Contents', 'Resources', 'engine');
    const packagedBin = path.join(packagedEngine, 'bin');
    fs.mkdirSync(packagedBin, { recursive: true });
    fs.mkdirSync(path.join(packagedApp, 'Contents', 'MacOS'), { recursive: true });
    fs.copyFileSync(BIN, path.join(packagedBin, 'ai-acct-autopilot.js'));
    fs.copyFileSync(path.join(__dirname, '..', 'bin', 'usage-stats.js'), path.join(packagedBin, 'usage-stats.js'));
    fs.writeFileSync(path.join(packagedEngine, 'package.json'), JSON.stringify({ version: '1.1.3' }));
    fs.writeFileSync(path.join(packagedApp, 'Contents', 'MacOS', 'AIAcctAutopilot'), '', { mode: 0o755 });
    r = runScript(sb, path.join(packagedBin, 'ai-acct-autopilot.js'), ['app-diagnose', '--json'], { AI_ACCT_CODEX_BIN: stock });
    const packagedDiag = JSON.parse(r.stdout);
    check('packaged engine diagnoses its containing DMG app path', r.status === 0
      && packagedDiag.menubar.app === fs.realpathSync(packagedApp) && packagedDiag.menubar.appExists === true, r.stdout + r.stderr);
  }

  // ── S20: menubar install/status/uninstall — fake swiftc/launchctl/open;
  //         the bundle lands in the sandbox HOME, never in real ~/Applications
  {
    const sb = sandbox('s20');
    const fakeSwiftc = sb.sh('fakeswiftc', `out=""
prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
[ -n "$out" ] || exit 1
printf '#!/bin/sh\\nexit 0\\n' > "$out"
chmod +x "$out"`);
    // launchctl always failing covers the bootstrap→open fallback; bootout
    // failures are ignored by design
    sb.sh('launchctl', `echo "$@" >> "${sb.home}/fixtures/launchctl.log"; exit 1`);
    sb.sh('open', `echo "$@" >> "${sb.home}/fixtures/open.log"; exit 0`);
    // real codesign rejects a shell-script "binary"; the fake also keeps the
    // suite hermetic. The bundle seal is mandatory — an unsealed bundle dies
    // under taskgated with SIGKILL (Code Signature Invalid).
    sb.sh('codesign', `echo "$@" >> "${sb.home}/fixtures/codesign.log"; exit 0`);
    // pin the prebuilt seam to a missing path: these scenarios prove the
    // swiftc fallback, and must not pick up a real menubar/prebuilt/ binary
    // sitting in the repo (built by prepack on a maintainer machine)
    const env = { AI_ACCT_SWIFTC: fakeSwiftc, AI_ACCT_MENUBAR_PREBUILT: path.join(sb.home, 'no-prebuilt') };
    const app = path.join(sb.home, 'Applications', 'AI Acct Autopilot.app');
    const agent = path.join(sb.home, 'Library', 'LaunchAgents', 'com.ai-acct-autopilot.menubar.plist');

    let r = runCli(sb, ['menubar', 'install'], env);
    check('menubar install builds the app bundle', r.status === 0 && fs.existsSync(path.join(app, 'Contents', 'MacOS', 'AIAcctAutopilot')), r.stderr);
    check('install seals the bundle with ad-hoc codesign', sb.read('fixtures/codesign.log').includes('AI Acct Autopilot.app'), sb.read('fixtures/codesign.log'));
    check('npm menubar install uses ad-hoc bundle seal without hardened entitlements', !sb.read('fixtures/codesign.log').includes('--entitlements'));
    const info = sb.read('Applications/AI Acct Autopilot.app/Contents/Info.plist');
    check('bundle Info.plist is a UI-less agent app', info.includes('<key>LSUIElement</key><true/>') && info.includes('com.ai-acct-autopilot.menubar'));
    const cfg = sb.json('Applications/AI Acct Autopilot.app/Contents/Resources/config.json');
    check('bundle config bakes absolute node/script/claude-acct paths + version', !!cfg && cfg.node === process.execPath
      && path.isAbsolute(cfg.script) && cfg.script.endsWith('ai-acct-autopilot.js') && path.isAbsolute(cfg.claudeAcct)
      && cfg.version === require(path.join(__dirname, '..', 'package.json')).version, JSON.stringify(cfg));
    check('launch agent plist written with the bundle binary', sb.read('Library/LaunchAgents/com.ai-acct-autopilot.menubar.plist').includes('Contents/MacOS/AIAcctAutopilot'));
    check('failed bootstrap falls back to open', sb.read('fixtures/launchctl.log').includes('bootstrap') && sb.read('fixtures/open.log').includes('.app'));

    r = runCli(sb, ['menubar', 'status'], env);
    check('menubar status reports app + agent, not running (empty ps)', r.status === 0
      && r.stdout.includes('AI Acct Autopilot.app') && r.stdout.includes('LaunchAgents') && r.stdout.includes('not running'), r.stdout);
    r = runCli(sb, ['menubar', 'start'], env);
    check('menubar start opens the built app', r.status === 0 && sb.read('fixtures/open.log').trim().split('\n').length >= 2);
    r = runCli(sb, ['menubar', 'stop'], env);
    check('menubar stop boots the agent out', r.status === 0 && sb.read('fixtures/launchctl.log').includes('bootout'), r.stdout);
    r = runCli(sb, ['menubar', 'uninstall'], env);
    check('menubar uninstall removes bundle + agent', r.status === 0 && !fs.existsSync(app) && !fs.existsSync(agent), r.stdout);
    r = runCli(sb, ['menubar', 'status'], env);
    check('status after uninstall says not built', r.stdout.includes('not built'), r.stdout);
    r = runCli(sb, ['menubar', 'start'], env);
    check('menubar start without a build errors', r.status === 1 && r.stderr.includes('not built'), r.stderr);
    const bad = sb.sh('badswiftc', 'echo boom >&2; exit 1');
    r = runCli(sb, ['menubar', 'build'], { ...env, AI_ACCT_SWIFTC: bad });
    check('menubar build surfaces a swiftc failure', r.status === 1 && r.stderr.includes('swiftc failed') && r.stderr.includes('boom'), r.stderr);
    r = runCli(sb, ['menubar', 'wat'], env);
    check('unknown menubar subcommand prints usage', r.status === 1 && r.stderr.includes('usage:'));

    // prebuilt binary path: npm installs ship menubar/prebuilt/AIAcctAutopilot —
    // build must copy it verbatim and never invoke swiftc
    const prebuilt = sb.write('prebuilt-bin', '#!/bin/sh\n# fake prebuilt universal binary\nexit 0\n');
    const loggingSwiftc = sb.sh('logswiftc', `echo "$@" >> "${sb.home}/fixtures/swiftc.log"
out=""
prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
printf '#!/bin/sh\\n# compiled-from-source marker\\nexit 0\\n' > "$out"
chmod +x "$out"`);
    const envPre = { AI_ACCT_SWIFTC: loggingSwiftc, AI_ACCT_MENUBAR_PREBUILT: prebuilt };
    r = runCli(sb, ['menubar', 'build'], envPre);
    const binPath = 'Applications/AI Acct Autopilot.app/Contents/MacOS/AIAcctAutopilot';
    check('prebuilt binary used without compiling', r.status === 0 && r.stdout.includes('(prebuilt)')
      && sb.read(binPath).includes('fake prebuilt universal binary') && !sb.read('fixtures/swiftc.log'), r.stdout + r.stderr);
    check('prebuilt copy is executable', (fs.statSync(path.join(sb.home, binPath)).mode & 0o111) !== 0);
    r = runCli(sb, ['menubar', 'build', '--from-source'], envPre);
    check('--from-source compiles even when a prebuilt exists', r.status === 0 && r.stdout.includes('(compiled from source)')
      && sb.read(binPath).includes('compiled-from-source marker') && sb.read('fixtures/swiftc.log').includes('-o'), r.stdout + r.stderr);
    sb.sh('codesign', 'echo "seal boom" >&2; exit 1');
    r = runCli(sb, ['menubar', 'build'], envPre);
    check('failed bundle seal fails the build loudly', r.status === 1 && r.stderr.includes('codesign') && r.stderr.includes('seal boom'), r.stderr);
  }

  global.__mock.kill();
  console.log(`${pass} passed, ${fail} failed`);
  if (fail) { console.log(`sandbox kept for debugging: ${ROOT}`); process.exit(1); }
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => {
  try { global.__mock && global.__mock.kill(); } catch {}
  console.error('e2e suite crashed:', e);
  console.log(`sandbox kept: ${ROOT}`);
  process.exit(1);
});
