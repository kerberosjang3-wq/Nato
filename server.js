'use strict';

const _fetch = typeof fetch !== 'undefined' ? fetch : require('node-fetch');

if (!process.env.VERCEL) {
  try { require('dotenv').config({ path: '.env.local' }); } catch {}
}

const express = require('express');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const app = express();
app.use(express.json());

// ── Paths (Root version) ──────────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, 'data.json');
const VAPID_FILE = path.join(__dirname, '.vapid.json');
const KR_STOCKS_FILE = path.join(__dirname, 'kr-stocks.json');

// ── Storage ────────────────────────────────────────────────────────────────
let _fileCache = null;

async function redisCmd(cmd, ...args) {
  if (!process.env.UPSTASH_REDIS_REST_URL) throw new Error('Redis URL missing');
  const res = await _fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([cmd, ...args]),
  });
  if (!res.ok) throw new Error(`Redis HTTP ${res.status}`);
  const { result, error } = await res.json();
  if (error) throw new Error(`Redis: ${error}`);
  return result;
}

async function getStore() {
  if (process.env.UPSTASH_REDIS_REST_URL) {
    try {
      const raw = await redisCmd('GET', 'stock-alarm-v1');
      const data = raw ? JSON.parse(raw) : {};
      return { watchlists: data.watchlists || {}, subscriptions: data.subscriptions || {} };
    } catch (e) {
      return { watchlists: {}, subscriptions: {} };
    }
  }
  if (!_fileCache) {
    try {
      _fileCache = fs.existsSync(DATA_FILE) ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) : null;
    } catch (e) {}
    if (!_fileCache) _fileCache = { watchlists: {}, subscriptions: {} };
  }
  return _fileCache;
}

async function saveStore(data) {
  if (process.env.UPSTASH_REDIS_REST_URL) {
    try { await redisCmd('SET', 'stock-alarm-v1', JSON.stringify(data)); } catch (e) {}
    return;
  }
  _fileCache = data;
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); } catch (_) {}
}

// ── VAPID ──────────────────────────────────────────────────────────────────
let vapidKeys;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  vapidKeys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
} else {
  try {
    if (fs.existsSync(VAPID_FILE)) {
      vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
    } else {
      vapidKeys = webpush.generateVAPIDKeys();
      try { fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys)); } catch (_) {}
    }
  } catch (e) {
    vapidKeys = webpush.generateVAPIDKeys();
  }
}

if (vapidKeys?.publicKey && vapidKeys?.privateKey) {
  webpush.setVapidDetails('mailto:admin@stockalarm.app', vapidKeys.publicKey, vapidKeys.privateKey);
}

// ── API Routes ─────────────────────────────────────────────────────────────
const getCid = (req) => req.headers['x-client-id'] || 'default';

app.get('/api/vapidPublicKey', (req, res) => res.json({ publicKey: vapidKeys?.publicKey }));
app.get('/api/watchlist', async (req, res) => {
  try { const s = await getStore(); res.json(s.watchlists[getCid(req)] || {}); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/watchlist', async (req, res) => {
  try {
    const s = await getStore();
    const id = getCid(req);
    if (!s.watchlists[id]) s.watchlists[id] = {};
    s.watchlists[id][req.body.symbol] = { ...req.body, addedAt: Date.now() };
    await saveStore(s);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 한국 종목 데이터 로드
let KR_STOCKS = [];
try {
  if (fs.existsSync(KR_STOCKS_FILE)) {
    KR_STOCKS = JSON.parse(fs.readFileSync(KR_STOCKS_FILE, 'utf8')).map(s => ({
      symbol: s.s, shortname: s.n, longname: s.n,
      exchange: s.s.endsWith('.KQ') ? 'KOQ' : 'KSC',
      quoteType: 'EQUITY'
    }));
  }
} catch (_) {}

app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ quotes: [] });
  if (/[\uAC00-\uD7A3]/.test(q)) {
    return res.json({ quotes: KR_STOCKS.filter(s => s.shortname.includes(q) || s.symbol.includes(q.toUpperCase())).slice(0, 10) });
  }
  try {
    const r = await _fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10`, { timeout: 5000 });
    res.json(await r.json());
  } catch (_) { res.json({ quotes: [] }); }
});

app.get('/api/quote', async (req, res) => {
  try {
    const r1 = await _fetch('https://fc.yahoo.com', { timeout: 5000 });
    const cookie = (r1.headers.raw()['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    const r2 = await _fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { 'Cookie': cookie }, timeout: 5000 });
    const crumb = await r2.text();
    const r3 = await _fetch(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${req.query.symbols}&crumb=${encodeURIComponent(crumb)}`, { headers: { 'Cookie': cookie }, timeout: 8000 });
    const data = await r3.json();
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', env: process.env.VERCEL ? 'vercel' : 'local' }));

// 정적 파일 미들웨어 (로컬 전용)
if (!process.env.VERCEL) {
  app.use(express.static(path.join(__dirname, 'public')));
}

module.exports = app;

// 로컬 실행
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));
}
