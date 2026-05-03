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
app.use(express.static(path.join(__dirname, 'public')));

// ── Storage: Upstash Redis (Vercel) or JSON file (로컬) ────────────────────
// 외부 패키지 없이 Upstash REST API를 직접 호출
const DATA_FILE = path.join(__dirname, 'data.json');
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
    const raw = await redisCmd('GET', 'stock-alarm-v1');
    const data = raw ? JSON.parse(raw) : {};
    if (!data.watchlists) data.watchlists = {};
    if (!data.subscriptions) data.subscriptions = {};
    return data;
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
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ── VAPID Setup: 환경변수 우선, 없으면 파일, 없으면 생성 ──────────────────
const VAPID_FILE = path.join(__dirname, '.vapid.json');
let vapidKeys;

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  vapidKeys = {
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
  };
} else if (fs.existsSync(VAPID_FILE)) {
  vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
} else {
  vapidKeys = webpush.generateVAPIDKeys();
  try { fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys)); } catch {}
  console.log('\n🔑 VAPID 키 생성됨. .env.local에 추가하세요:');
  console.log(`VAPID_PUBLIC_KEY=${vapidKeys.publicKey}`);
  console.log(`VAPID_PRIVATE_KEY=${vapidKeys.privateKey}\n`);
}

webpush.setVapidDetails('mailto:admin@stockalarm.app', vapidKeys.publicKey, vapidKeys.privateKey);

// ── PNG Icon Generator (외부 라이브러리 없음) ──────────────────────────────
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
  const barHeights = [0.35, 0.52, 0.42, 0.68, 0.82];
  const barW = Math.max(4, Math.floor(size * 0.10));
  const gap = Math.max(2, Math.floor(size * 0.04));
  const startX = Math.floor(size * 0.14);
  const bottom = Math.floor(size * 0.82);
  barHeights.forEach((h, i) => {
    const x0 = startX + i * (barW + gap);
    const bh = Math.floor(size * h * 0.6);
    for (let py = bottom - bh; py < bottom; py++) {
      for (let px = x0; px < x0 + barW; px++) {
        if (px >= 0 && px < size && py >= 0 && py < size) {
          const idx = (py * size + px) * 3;
          pixels[idx] = pixels[idx + 1] = pixels[idx + 2] = 240;
        }
      }
    }
  });
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

// ── Yahoo Finance 인증: fc.yahoo.com 쿠키 + crumb (v7/quote 사용) ──────────
const _YF = { crumb: null, cookie: null, expiry: 0 };

async function getYahooCrumb() {
  if (_YF.crumb && Date.now() < _YF.expiry) return _YF;
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  // Step 1: 쿠키 획득 (fc.yahoo.com — 헤더가 가벼워 overflow 없음)
  const r1 = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'follow', timeout: 8000 });
  _YF.cookie = (r1.headers.raw()['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
  // Step 2: crumb 획득
  const r2 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, 'Cookie': _YF.cookie },
    timeout: 5000,
  });
  _YF.crumb = await r2.text();
  _YF.expiry = Date.now() + 50 * 60 * 1000; // 50분 캐시
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
    // 인증 만료 시 캐시 초기화 후 다음 호출에서 재시도
    if (r.status === 401 || r.status === 403) _YF.expiry = 0;
    throw new Error(`Yahoo Finance HTTP ${r.status}`);
  }
  const data = await r.json();
  return data.quoteResponse?.result || [];
}

// ── Push Notification Helper ───────────────────────────────────────────────
async function sendPush(subscription, payload) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return 'ok';
  } catch (e) {
    if (e.statusCode === 410 || e.statusCode === 404) return 'expired';
    console.error('Push error:', e.message);
    return 'error';
  }
}

// ── 가격 체크 핵심 로직 (Cron 엔드포인트 + 로컬 node-cron 공용) ───────────
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
    console.error('Quote fetch error:', e.message);
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
            tag: `alert-low-${symbol}`, icon: '/icons/icon-192.png',
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
            tag: `alert-high-${symbol}`, icon: '/icons/icon-192.png',
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
function cid(req) { return req.headers['x-client-id'] || 'default'; }

app.get('/api/vapidPublicKey', (_req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

app.post('/api/subscribe', async (req, res) => {
  try {
    const store = await getStore();
    store.subscriptions[cid(req)] = req.body;
    await saveStore(store);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/unsubscribe', async (req, res) => {
  try {
    const store = await getStore();
    const id = cid(req);
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
    res.json(store.watchlists[cid(req)] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/watchlist', async (req, res) => {
  const { symbol, name, alertPrice, targetPrice, currency } = req.body;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  try {
    const store = await getStore();
    const id = cid(req);
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
    const id = cid(req);
    const sym = decodeURIComponent(req.params.symbol);
    if (store.watchlists[id]) delete store.watchlists[id][sym];
    await saveStore(store);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ quotes: [] });
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&listsCount=0`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }, timeout: 8000 }
    );
    res.json(await r.json());
  } catch (e) {
    res.status(502).json({ quotes: [], error: e.message });
  }
});

app.get('/api/quote', async (req, res) => {
  const { symbols } = req.query;
  if (!symbols) return res.json({ quoteResponse: { result: [] } });
  try {
    const symList = symbols.split(',').map(s => s.trim()).filter(Boolean);
    const result = await fetchQuotesBatch(symList);
    res.json({ quoteResponse: { result } });
  } catch (e) {
    res.status(502).json({ quoteResponse: { result: [] }, error: e.message });
  }
});

// ── Cron 엔드포인트 (Vercel Cron 또는 외부 cron 서비스가 호출) ─────────────
app.get('/api/cron', async (req, res) => {
  // CRON_SECRET이 설정된 경우 인증 검사
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await checkPrices();
    res.json({ ok: true, ...result, ts: new Date().toISOString() });
  } catch (e) {
    console.error('Cron error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Vercel용 export ────────────────────────────────────────────────────────
module.exports = app;

// ── 로컬 개발: 직접 실행 시만 서버 시작 + node-cron 활성화 ─────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\n🚀 주식알람 PWA: http://localhost:${PORT}`);
    console.log(`   저장소: ${process.env.UPSTASH_REDIS_REST_URL ? 'Upstash Redis' : 'data.json'}\n`);
  });
  // 로컬에서는 node-cron으로 2분마다 자동 체크
  try {
    const cron = require('node-cron');
    cron.schedule('*/2 * * * *', () => checkPrices().catch(e => console.error('Cron:', e.message)));
    console.log('⏰ 가격 모니터링: 2분마다');
  } catch {}
}
