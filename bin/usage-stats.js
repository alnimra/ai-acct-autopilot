// usage-stats.js — account-independent cost/token stats from LOCAL session logs
// (codexbar-style): today cost, 30d cost, 30d tokens, latest tokens, top model,
// 30-day daily histogram. Sources:
//   Claude: ~/.claude/projects/**/*.jsonl   (assistant messages w/ usage)
//   Codex:  ~/.codex/sessions/YYYY/MM/DD/*.jsonl + ~/.codex/archived_sessions/
//           (token_count events, summed per-event last_token_usage)
// Estimated at API rates — token traffic on this Mac regardless of account.
// Pricing mirrors CodexBar's CostUsagePricing table (steipete/CodexBar) so the
// two tools agree on rates. Known residual vs CodexBar: it additionally
// subtracts fork/resume-inherited token baselines across session files, so its
// codex total can read ~10-20% LOWER than ours on resume-heavy workloads.
//
// Incremental: per-file byte offsets + day aggregates cached in
// ~/.cache/ai-acct-autopilot/stats-cache.json; logs are append-only, so each scan
// reads only new bytes. Claude messages dedupe via a persisted seen-id set
// (resumed/compacted sessions re-write old messages into new files).

'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = os.homedir();
const CACHE_DIR = path.join(HOME, '.cache', 'ai-acct-autopilot');
const CACHE_FILE = path.join(CACHE_DIR, 'stats-cache.json');
const WINDOW_DAYS = 31;

// USD per MTok — mirrors CodexBar's CostUsagePricing table (steipete/CodexBar,
// Sources/CodexBarCore/Vendored/CostUsage/CostUsagePricing.swift) so the
// panel's numbers agree with codexbar's.
// Codex: [in, out, cacheRead, thresholdTokens, inAbove, outAbove, cacheAbove]
// (whole event billed at "above" rates when its input_tokens > threshold)
const CODEX_PRICES = {
  'gpt-5.5':             [5, 30, 0.5, 272_000, 10, 45, 1],
  'gpt-5.5-pro':         [30, 180, null],
  'gpt-5.4':             [2.5, 15, 0.25, 272_000, 5, 22.5, 0.5],
  'gpt-5.4-mini':        [0.75, 4.5, 0.075],
  'gpt-5.4-nano':        [0.2, 1.25, 0.02],
  'gpt-5.4-pro':         [30, 180, null],
  'gpt-5.3-codex':       [1.75, 14, 0.175],
  'gpt-5.3-codex-spark': [0, 0, 0],          // research preview — free
  'gpt-5.2':             [1.75, 14, 0.175],
  'gpt-5.2-codex':       [1.75, 14, 0.175],
  'gpt-5.2-pro':         [21, 168, null],
  'gpt-5.1':             [1.25, 10, 0.125],
  'gpt-5.1-codex':       [1.25, 10, 0.125],
  'gpt-5.1-codex-max':   [1.25, 10, 0.125],
  'gpt-5.1-codex-mini':  [0.25, 2, 0.025],
  'gpt-5':               [1.25, 10, 0.125],
  'gpt-5-codex':         [1.25, 10, 0.125],
  'gpt-5-mini':          [0.25, 2, 0.025],
  'gpt-5-nano':          [0.05, 0.4, 0.005],
  'gpt-5-pro':           [15, 120, null],
};
// Claude: [in, out, cacheWrite, cacheRead]
const CLAUDE_PRICES = {
  'claude-fable-5':   [10, 50, 12.5, 1],
  'claude-opus-4-8':  [5, 25, 6.25, 0.5],
  'claude-opus-4-7':  [5, 25, 6.25, 0.5],
  'claude-opus-4-6':  [5, 25, 6.25, 0.5],
  'claude-opus-4-5':  [5, 25, 6.25, 0.5],
  'claude-opus-4-1':  [15, 75, 18.75, 1.5],
  'claude-opus-4':    [15, 75, 18.75, 1.5],
  'claude-sonnet-4-6': [3, 15, 3.75, 0.3],
  'claude-sonnet-4-5': [3, 15, 3.75, 0.3],
  'claude-sonnet-4':  [3, 15, 3.75, 0.3],
  'claude-haiku-4-5': [1, 5, 1.25, 0.1],
};
// normalize: strip provider prefixes + dated suffixes, then longest-prefix match
function lookupPrice(table, model) {
  let m = String(model || '').trim().replace(/^(openai\/|anthropic\.)/, '');
  m = m.replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-\d{8}$/, '');
  if (table[m]) return table[m];
  let best = null;
  for (const k of Object.keys(table)) {
    if (m.startsWith(k) && (!best || k.length > best.length)) best = k;
  }
  return best ? table[best] : null;
}
function claudePriceFor(model) {
  const p = lookupPrice(CLAUDE_PRICES, model);
  if (p) return { i: p[0], o: p[1], cw: p[2], cr: p[3] };
  if (/fable|mythos/i.test(model || '')) return { i: 10, o: 50, cw: 12.5, cr: 1 };
  if (/opus/i.test(model || '')) return { i: 5, o: 25, cw: 6.25, cr: 0.5 };
  if (/haiku/i.test(model || '')) return { i: 1, o: 5, cw: 1.25, cr: 0.1 };
  return { i: 3, o: 15, cw: 3.75, cr: 0.30 };  // sonnet-class default
}
// Per-event codex cost in USD, codexbar-style (threshold reprices the event).
function codexCostUSD(model, inT, cached, out) {
  const p = lookupPrice(CODEX_PRICES, model) || CODEX_PRICES['gpt-5.5'];
  const [pin, pout, pcr, thr, pinA, poutA, pcrA] = p;
  const cach = Math.min(Math.max(0, cached), Math.max(0, inT));
  const nonCached = Math.max(0, inT - cach);
  const above = thr && inT > thr;
  const inRate = above ? (pinA ?? pin) : pin;
  const outRate = above ? (poutA ?? pout) : pout;
  const crBase = above ? (pcrA ?? pcr) : pcr;
  const crRate = crBase == null ? inRate : crBase;
  return (nonCached * inRate + cach * crRate + out * outRate) / 1e6;
}

const dayKey = (ts) => {
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ---------- streaming line parser (byte-accurate offsets) ----------
function parseNewLines(file, fromOffset, onLine) {
  return new Promise((resolve) => {
    let size;
    try { size = fs.statSync(file).size; } catch { resolve(fromOffset); return; }
    if (size <= fromOffset) { resolve(size < fromOffset ? 0 : fromOffset); return; } // shrunk → reset
    const stream = fs.createReadStream(file, { start: fromOffset });
    let tail = Buffer.alloc(0);
    let consumed = fromOffset;
    stream.on('data', (chunk) => {
      const buf = tail.length ? Buffer.concat([tail, chunk]) : chunk;
      let start = 0;
      for (;;) {
        const nl = buf.indexOf(10, start);
        if (nl === -1) break;
        const line = buf.subarray(start, nl).toString('utf8');
        consumed += nl - start + 1;
        if (line.trim()) { try { onLine(JSON.parse(line)); } catch {} }
        start = nl + 1;
      }
      tail = Buffer.from(buf.subarray(start)); // copy — chunk buffer gets reused
      stream.destroyed || null;
    });
    stream.on('end', () => resolve(consumed));
    stream.on('error', () => resolve(consumed));
  });
}

// ---------- per-provider line handlers ----------
function claudeHandler(rec, seen) {
  return (l) => {
    if (l.type !== 'assistant' || !l.message || !l.message.usage) return;
    const u = l.message.usage;
    const id = l.message.id ? `${l.message.id}:${l.requestId || ''}` : null;
    if (id) { if (seen[id]) return; seen[id] = Date.parse(l.timestamp) || Date.now(); }
    const day = dayKey(l.timestamp);
    if (!day) return;
    const model = l.message.model || 'claude';
    if (/synthetic/.test(model)) return;
    const p = claudePriceFor(model);
    const inT = u.input_tokens || 0, out = u.output_tokens || 0;
    const cw = u.cache_creation_input_tokens || 0, cr = u.cache_read_input_tokens || 0;
    const cost = (inT * p.i + out * p.o + cw * p.cw + cr * p.cr) / 1e6;
    const d = rec.days[day] || (rec.days[day] = { cost: 0, tokens: 0, models: {} });
    d.cost += cost; d.tokens += inT + out + cw + cr;
    d.models[model] = (d.models[model] || 0) + cost;
    const ts = Date.parse(l.timestamp) || 0;
    if (ts >= (rec.lastTs || 0)) { rec.lastTs = ts; rec.lastTokens = inT + cr + cw + out; }
  };
}

function codexHandler(rec, live) {
  let model = rec.model || 'gpt-5';
  return (l) => {
    const pl = l.payload || {};
    if (l.type === 'turn_context' && pl.model) { model = pl.model; rec.model = model; return; }
    if (pl.type !== 'token_count' || !pl.info) return;
    const u = pl.info.last_token_usage || {};
    const day = dayKey(l.timestamp);
    if (!day) return;
    const inT = u.input_tokens || 0, cached = Math.min(u.cached_input_tokens || 0, inT), out = u.output_tokens || 0;
    const cost = codexCostUSD(model, inT, cached, out);
    const d = rec.days[day] || (rec.days[day] = { cost: 0, tokens: 0, models: {} });
    d.cost += cost; d.tokens += inT + out;
    d.models[model] = (d.models[model] || 0) + cost;
    const ts = Date.parse(l.timestamp) || 0;
    if (ts >= (rec.lastTs || 0)) {
      rec.lastTs = ts;
      rec.lastTokens = (pl.info.total_token_usage || {}).total_tokens || 0;
    }
    if (pl.rate_limits && ts >= (live.ts || 0)) {
      live.ts = ts; live.rateLimits = pl.rate_limits; live.model = model;
      live.contextWindow = pl.info.model_context_window || null;
    }
  };
}

// ---------- file discovery ----------
function claudeFiles() {
  const root = path.join(HOME, '.claude', 'projects');
  const cutoff = Date.now() - WINDOW_DAYS * 86_400_000;
  const out = [];
  const walk = (dir, depth) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 3) walk(p, depth + 1); continue; }
      if (!e.name.endsWith('.jsonl')) continue;
      try { const st = fs.statSync(p); if (st.mtimeMs >= cutoff) out.push({ path: p, mtime: st.mtimeMs, size: st.size }); } catch {}
    }
  };
  walk(root, 0);
  return out;
}

function codexFiles() {
  const root = path.join(HOME, '.codex', 'sessions');
  const out = [];
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const d = new Date(Date.now() - i * 86_400_000);
    const dir = path.join(root, String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    let ents = [];
    try { ents = fs.readdirSync(dir); } catch { continue; }
    for (const name of ents) {
      if (!name.endsWith('.jsonl')) continue;
      const p = path.join(dir, name);
      try { const st = fs.statSync(p); out.push({ path: p, mtime: st.mtimeMs, size: st.size }); } catch {}
    }
  }
  // archived sessions (flat dir; mv preserves mtime) — codexbar scans these too
  const archived = path.join(HOME, '.codex', 'archived_sessions');
  const cutoff = Date.now() - WINDOW_DAYS * 86_400_000;
  let ents = [];
  try { ents = fs.readdirSync(archived); } catch {}
  for (const name of ents) {
    if (!name.endsWith('.jsonl')) continue;
    const p = path.join(archived, name);
    try { const st = fs.statSync(p); if (st.mtimeMs >= cutoff) out.push({ path: p, mtime: st.mtimeMs, size: st.size }); } catch {}
  }
  return out;
}

// ---------- cache ----------
function loadCache() {
  // version bump invalidates cached day aggregates when pricing changes
  try { const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); if (c.version === 2) return c; } catch {}
  return { version: 2, files: {}, claudeSeen: {}, codexLive: {} };
}
function saveCache(cache) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = `${CACHE_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, CACHE_FILE);
  } catch {}
}

// ---------- aggregation ----------
function aggregate(cache, provider) {
  const days = {};
  let lastTs = 0, lastTokens = null, model = null;
  for (const [p, rec] of Object.entries(cache.files)) {
    if (rec.provider !== provider) continue;
    for (const [day, d] of Object.entries(rec.days || {})) {
      const t = days[day] || (days[day] = { cost: 0, tokens: 0, models: {} });
      t.cost += d.cost; t.tokens += d.tokens;
      for (const [m, c] of Object.entries(d.models || {})) t.models[m] = (t.models[m] || 0) + c;
    }
    if ((rec.lastTs || 0) > lastTs) { lastTs = rec.lastTs; lastTokens = rec.lastTokens; model = rec.model || null; }
  }
  const today = dayKey(Date.now());
  const keys = [];
  for (let i = 29; i >= 0; i--) keys.push(dayKey(Date.now() - i * 86_400_000));
  const hist = keys.map((k) => (days[k] ? days[k].cost : 0));
  let cost30 = 0, tok30 = 0;
  const modelCost = {};
  for (const k of keys) {
    const d = days[k]; if (!d) continue;
    cost30 += d.cost; tok30 += d.tokens;
    for (const [m, c] of Object.entries(d.models)) modelCost[m] = (modelCost[m] || 0) + c;
  }
  const top = Object.entries(modelCost).sort((a, b) => b[1] - a[1])[0];
  return {
    todayCost: days[today] ? days[today].cost : 0,
    cost30, tokens30: tok30, lastTokens, lastTs,
    topModel: top ? top[0] : null, hist,
  };
}

// ---------- public API ----------
let running = false;
async function collect(onProgress) {
  if (running) return null;
  running = true;
  try {
    const cache = loadCache();
    const live = cache.codexLive || {};
    const all = [
      ...claudeFiles().map((f) => ({ ...f, provider: 'claude' })),
      ...codexFiles().map((f) => ({ ...f, provider: 'codex' })),
    ];
    // prune cache entries that left the window
    const keep = new Set(all.map((f) => f.path));
    for (const p of Object.keys(cache.files)) if (!keep.has(p)) delete cache.files[p];
    const dirty = all.filter((f) => {
      const rec = cache.files[f.path];
      return !rec || rec.size !== f.size || rec.mtime !== f.mtime;
    });
    let done = 0;
    for (const f of dirty) {
      const rec = cache.files[f.path] || { provider: f.provider, offset: 0, days: {}, lastTs: 0, lastTokens: null };
      if (f.size < (rec.offset || 0)) { rec.offset = 0; rec.days = {}; } // rewritten file → reparse
      const handler = f.provider === 'claude' ? claudeHandler(rec, cache.claudeSeen) : codexHandler(rec, live);
      rec.offset = await parseNewLines(f.path, rec.offset || 0, handler);
      rec.size = f.size; rec.mtime = f.mtime; rec.provider = f.provider;
      cache.files[f.path] = rec;
      done++;
      if (onProgress && (done % 25 === 0 || done === dirty.length)) onProgress(done, dirty.length);
    }
    // prune seen ids older than the window
    const cut = Date.now() - (WINDOW_DAYS + 4) * 86_400_000;
    for (const [id, ts] of Object.entries(cache.claudeSeen)) if (ts < cut) delete cache.claudeSeen[id];
    cache.codexLive = live;
    saveCache(cache);
    return {
      claude: aggregate(cache, 'claude'),
      codex: aggregate(cache, 'codex'),
      codexLive: live,
      scannedFiles: dirty.length,
      generatedAt: Date.now(),
    };
  } finally { running = false; }
}

function cachedStats() {
  const cache = loadCache();
  if (!Object.keys(cache.files).length) return null;
  return {
    claude: aggregate(cache, 'claude'),
    codex: aggregate(cache, 'codex'),
    codexLive: cache.codexLive || {},
    scannedFiles: 0,
    generatedAt: Date.now(),
  };
}

module.exports = { collect, cachedStats };
