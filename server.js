'use strict';

// node-fetch v2는 headers.raw()와 timeout 옵션을 지원하므로 항상 명시적으로 불러온다.
// Node.js 18+의 네이티브 fetch는 headers.raw()가 없어 Yahoo Finance 쿠키 처리가 실패한다.
const nodeFetch = require('node-fetch');
const _fetch = typeof fetch !== 'undefined' ? fetch : nodeFetch;

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
app.use(express.static(path.join(__dirname, 'public')));

// ── Paths ──────────────────────────────────────────────────────────────────
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
      return { 
        watchlists: data.watchlists || {}, 
        subscriptions: data.subscriptions || {} 
      };
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

// ── Push Helpers ───────────────────────────────────────────────────────────
async function sendPush(subscription, payload) {
  try { 
    await webpush.sendNotification(subscription, JSON.stringify(payload)); 
    return 'ok'; 
  } catch (e) { 
    if (e.statusCode === 410 || e.statusCode === 404) return 'expired';
    return 'error';
  }
}

async function getYahooCrumb() {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  // node-fetch v2 사용: headers.raw()와 timeout 옵션이 필요하므로 nodeFetch를 직접 사용한다.
  const r1 = await nodeFetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, timeout: 5000 });
  const cookie = (r1.headers.raw()['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
  const r2 = await nodeFetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, 'Cookie': cookie }, timeout: 5000 });
  const crumb = await r2.text();
  return { crumb, cookie };
}

async function fetchQuotesBatch(symbols) {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const { crumb, cookie } = await getYahooCrumb();
  const r = await _fetch(
    `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols.map(encodeURIComponent).join(',')}&crumb=${encodeURIComponent(crumb)}&fields=regularMarketPrice,shortName,currency,regularMarketChangePercent`,
    { headers: { 'User-Agent': UA, 'Cookie': cookie }, timeout: 10000 }
  );
  if (!r.ok) throw new Error(`Yahoo Finance ${r.status}`);
  const data = await r.json();
  return data.quoteResponse?.result || [];
}

async function checkPrices() {
  const store = await getStore();
  const allSymbols = new Set();
  Object.values(store.watchlists).forEach(wl => Object.keys(wl).forEach(s => allSymbols.add(s)));
  if (!allSymbols.size) return { checked: 0, notified: 0 };

  let quotes;
  try {
    const results = await fetchQuotesBatch([...allSymbols]);
    quotes = {};
    results.forEach(q => { quotes[q.symbol] = q; });
  } catch (e) {
    return { checked: 0, notified: 0, error: e.message };
  }

  const COOLDOWN = 4 * 60 * 60 * 1000;
  let dirty = false;
  let notified = 0;

  for (const [cid, watchlist] of Object.entries(store.watchlists)) {
    const subscription = store.subscriptions[cid];
    if (!subscription) continue;

    for (const [symbol, item] of Object.entries(watchlist)) {
      const q = quotes[symbol];
      if (!q) continue;
      const price = q.regularMarketPrice;
      const name = q.shortName || item.name || symbol;
      const currency = q.currency || item.currency || 'USD';
      const now = Date.now();
      const fmt = p => currency === 'KRW' ? `₩${p.toLocaleString('ko-KR')}` : `$${p.toFixed(2)}`;

      if (item.alertPrice && price <= item.alertPrice) {
        if ((now - (item.lastAlertLow || 0)) > COOLDOWN) {
          const res = await sendPush(subscription, {
            title: `🔔 관심가 도달! ${name}`,
            body: `현재가 ${fmt(price)} ≤ 관심가 ${fmt(item.alertPrice)}`,
            tag: `alert-low-${symbol}`, icon: '/icons/logo.png',
            data: { url: '/', symbol },
          });
          if (res === 'expired') { delete store.subscriptions[cid]; dirty = true; }
          else if (res === 'ok') { item.lastAlertLow = now; dirty = true; notified++; }
        }
      } else if (item.alertPrice && price > item.alertPrice * 1.01 && item.lastAlertLow) {
        item.lastAlertLow = 0; dirty = true;
      }

      if (item.targetPrice && price >= item.targetPrice) {
        if ((now - (item.lastAlertHigh || 0)) > COOLDOWN) {
          const res = await sendPush(subscription, {
            title: `🎯 목표가 도달! ${name}`,
            body: `현재가 ${fmt(price)} ≥ 목표가 ${fmt(item.targetPrice)}`,
            tag: `alert-high-${symbol}`, icon: '/icons/logo.png',
            data: { url: '/', symbol },
          });
          if (res === 'expired') { delete store.subscriptions[cid]; dirty = true; }
          else if (res === 'ok') { item.lastAlertHigh = now; dirty = true; notified++; }
        }
      } else if (item.targetPrice && price < item.targetPrice * 0.99 && item.lastAlertHigh) {
        item.lastAlertHigh = 0; dirty = true;
      }
    }
  }

  if (dirty) await saveStore(store);
  return { checked: allSymbols.size, notified };
}

// ── API Routes ─────────────────────────────────────────────────────────────
const getCid = (req) => req.headers['x-client-id'] || 'default';

app.get('/api/vapidPublicKey', (req, res) => res.json({ publicKey: vapidKeys?.publicKey }));

app.post('/api/subscribe', async (req, res) => {
  try {
    const store = await getStore();
    store.subscriptions[getCid(req)] = req.body;
    await saveStore(store);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/unsubscribe', async (req, res) => {
  try {
    const store = await getStore();
    const id = getCid(req);
    if (store.subscriptions[id]?.endpoint === req.body.endpoint) {
      delete store.subscriptions[id];
      await saveStore(store);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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

app.delete('/api/watchlist/:symbol', async (req, res) => {
  try {
    const s = await getStore();
    const id = getCid(req);
    const sym = decodeURIComponent(req.params.symbol);
    if (s.watchlists[id]) delete s.watchlists[id][sym];
    await saveStore(s);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Portfolio API ──────────────────────────────────────────────────────────
app.get('/api/portfolio', async (req, res) => {
  try { const s = await getStore(); res.json(s.portfolios?.[getCid(req)] || {}); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/portfolio', async (req, res) => {
  try {
    const s = await getStore();
    const id = getCid(req);
    if (!s.portfolios) s.portfolios = {};
    if (!s.portfolios[id]) s.portfolios[id] = {};
    s.portfolios[id][req.body.symbol] = { ...req.body, addedAt: Date.now() };
    await saveStore(s);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/portfolio/:symbol', async (req, res) => {
  try {
    const s = await getStore();
    const id = getCid(req);
    const sym = decodeURIComponent(req.params.symbol);
    if (s.portfolios?.[id]) delete s.portfolios[id][sym];
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
    const result = await fetchQuotesBatch(req.query.symbols.split(','));
    res.json({ quoteResponse: { result } });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/cron', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) return res.status(401).end();
  try {
    const result = await checkPrices();
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', env: process.env.VERCEL ? 'vercel' : 'local' }));

// Root route (Fallback)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

module.exports = app;

// 로컬 실행
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));
  
  // 로컬 가격 체크 (2분)
  try {
    const cron = require('node-cron');
    cron.schedule('*/2 * * * *', () => checkPrices().catch(console.error));
  } catch {}
}
