'use strict';

// 로컬 개발 시 .env.local 파일 로드 (Vercel에서는 무시됨)
if (!process.env.VERCEL) {
  try { require('dotenv').config({ path: '.env.local' }); } catch {}
}

const express = require('express');
const webpush = require('web-push');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const app = express();
app.use(express.json());

// Vercel에서 정적 파일은 기본적으로 Edge에서 서비스되지만, 
// 만약 이 함수가 루트를 핸들링하게 될 경우를 대비해 설정
app.use(express.static(path.join(__dirname, '../public')));

// ── Storage: Upstash Redis (Vercel) or JSON file (로컬) ────────────────────
const DATA_FILE = path.join(__dirname, '../data.json');
let _fileCache = null;

async function redisCmd(cmd, ...args) {
  const res = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
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
      if (!data.watchlists) data.watchlists = {};
      if (!data.subscriptions) data.subscriptions = {};
      return data;
    } catch (e) {
      console.error('Redis error:', e);
      // Redis 실패 시 빈 스토어 반환하거나 에러 던짐
      return { watchlists: {}, subscriptions: {} };
    }
  }
  // 로컬: 파일 사용
  if (!_fileCache) {
    _fileCache = fs.existsSync(DATA_FILE)
      ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
      : { watchlists: {}, subscriptions: {} };
    if (!_fileCache.watchlists) _fileCache.watchlists = {};
    if (!_fileCache.subscriptions) _fileCache.subscriptions = {};
  }
  return _fileCache;
}

async function saveStore(data) {
  if (process.env.UPSTASH_REDIS_REST_URL) {
    await redisCmd('SET', 'stock-alarm-v1', JSON.stringify(data));
    return;
  }
  _fileCache = data;
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.warn('File save failed (expected on Vercel):', e.message);
  }
}

// ── VAPID Setup ───────────────────────────────────────────────────────────
const VAPID_FILE = path.join(__dirname, '../.vapid.json');
let vapidKeys;

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  vapidKeys = {
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
  };
} else if (fs.existsSync(VAPID_FILE)) {
  vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
} else {
  // Vercel에서 키가 없으면 매번 생성되므로 알림 연동이 끊길 수 있음. 
  // 환경변수 설정을 권장하지만 일단 작동은 하도록 생성.
  vapidKeys = webpush.generateVAPIDKeys();
  try { fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys)); } catch {}
}

if (vapidKeys && vapidKeys.publicKey && vapidKeys.privateKey) {
  webpush.setVapidDetails('mailto:admin@stockalarm.app', vapidKeys.publicKey, vapidKeys.privateKey);
}

// ── PNG Icon Generator ─────────────────────────────────────────────────────
function crc32(buf) {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  let crc = 0xFFFFFFFF;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(data.length);
  const crcBuf = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crcBuf]);
}

function makePNG(size) {
  const pixels = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (2 * size);
      pixels[(y * size + x) * 3 + 0] = Math.round(37  + (5   - 37)  * t);
      pixels[(y * size + x) * 3 + 1] = Math.round(99  + (150 - 99)  * t);
      pixels[(y * size + x) * 3 + 2] = Math.round(235 + (105 - 235) * t);
    }
  }
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.allocUnsafe(1 + size * 3);
    row[0] = 0;
    for (let x = 0; x < size; x++) {
      row[1 + x * 3] = pixels[(y * size + x) * 3];
      row[2 + x * 3] = pixels[(y * size + x) * 3 + 1];
      row[3 + x * 3] = pixels[(y * size + x) * 3 + 2];
    }
    rows.push(row);
  }
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8); ihdr.writeUInt8(2, 9);
  ihdr.writeUInt8(0, 10); ihdr.writeUInt8(0, 11); ihdr.writeUInt8(0, 12);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const iconCache = {};
app.get('/icons/icon-:size.png', (req, res) => {
  const size = [192, 512].includes(+req.params.size) ? +req.params.size : 192;
  if (!iconCache[size]) iconCache[size] = makePNG(size);
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(iconCache[size]);
});

// ── Yahoo Finance API ──────────────────────────────────────────────────────
const _YF = { crumb: null, cookie: null, expiry: 0 };

async function getYahooCrumb() {
  if (_YF.crumb && Date.now() < _YF.expiry) return _YF;
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const r1 = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'follow', timeout: 8000 });
  _YF.cookie = (r1.headers.raw()['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
  const r2 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, 'Cookie': _YF.cookie },
    timeout: 5000,
  });
  _YF.crumb = await r2.text();
  _YF.expiry = Date.now() + 50 * 60 * 1000;
  return _YF;
}

async function fetchQuotesBatch(symbols) {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const { crumb, cookie } = await getYahooCrumb();
  const r = await fetch(
    `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols.map(encodeURIComponent).join(',')}&crumb=${encodeURIComponent(crumb)}&fields=regularMarketPrice,shortName,currency,regularMarketChangePercent,regularMarketChange`,
    { headers: { 'User-Agent': UA, 'Cookie': cookie, 'Accept': 'application/json' }, timeout: 10000 }
  );
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) _YF.expiry = 0;
    throw new Error(`Yahoo Finance HTTP ${r.status}`);
  }
  const data = await r.json();
  return data.quoteResponse?.result || [];
}

// ── Push Notification ──────────────────────────────────────────────────────
async function sendPush(subscription, payload) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return 'ok';
  } catch (e) {
    if (e.statusCode === 410 || e.statusCode === 404) return 'expired';
    return 'error';
  }
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

app.get('/api/vapidPublicKey', (_req, res) => res.json({ publicKey: vapidKeys.publicKey }));

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
  try {
    const store = await getStore();
    res.json(store.watchlists[getCid(req)] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/watchlist', async (req, res) => {
  const { symbol, name, alertPrice, targetPrice, currency } = req.body;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  try {
    const store = await getStore();
    const id = getCid(req);
    if (!store.watchlists[id]) store.watchlists[id] = {};
    store.watchlists[id][symbol] = {
      symbol, name, alertPrice, targetPrice, currency,
      addedAt: Date.now(), lastAlertLow: 0, lastAlertHigh: 0,
    };
    await saveStore(store);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/watchlist/:symbol', async (req, res) => {
  try {
    const store = await getStore();
    const id = getCid(req);
    const sym = decodeURIComponent(req.params.symbol);
    if (store.watchlists[id]) delete store.watchlists[id][sym];
    await saveStore(store);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 한국 종목 로드 (resilient require)
let KR_STOCKS = [];
try {
  KR_STOCKS = require('./kr-stocks.json').map(s => ({
    symbol: s.s, shortname: s.n, longname: s.n,
    exchange: s.s.endsWith('.KQ') ? 'KOQ' : 'KSC',
    quoteType: 'EQUITY',
  }));
} catch (e) {
  console.warn('KR stocks load failed:', e.message);
}

app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ quotes: [] });
  const hasKorean = /[\uAC00-\uD7A3]/.test(q);
  if (hasKorean) {
    const results = KR_STOCKS.filter(s => s.shortname.includes(q.trim()) || s.longname.includes(q.trim()) || s.symbol.toLowerCase().includes(q.toLowerCase().trim())).slice(0, 10);
    return res.json({ quotes: results });
  }
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&listsCount=0`, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
    res.json(await r.json());
  } catch (e) { res.json({ quotes: [] }); }
});

app.get('/api/quote', async (req, res) => {
  const { symbols } = req.query;
  if (!symbols) return res.json({ quoteResponse: { result: [] } });
  try {
    const result = await fetchQuotesBatch(symbols.split(',').map(s => s.trim()));
    res.json({ quoteResponse: { result } });
  } catch (e) { res.status(502).json({ quoteResponse: { result: [] }, error: e.message }); }
});

app.get('/api/cron', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) return res.status(401).end();
  try {
    const result = await checkPrices();
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Root route (Fallback)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

module.exports = app;

// 로컬 실행
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`🚀 Local: http://localhost:${PORT}`));
}
