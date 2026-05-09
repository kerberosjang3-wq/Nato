'use strict';

// node-fetch v2는 headers.raw()와 timeout 옵션을 지원하므로 항상 명시적으로 불러온다.
// Node.js 18+의 네이티브 fetch는 headers.raw()가 없어 Yahoo Finance 쿠키 처리가 실패한다.
const nodeFetch = require('node-fetch');
const _fetch = typeof fetch !== 'undefined' ? fetch : nodeFetch;

if (!process.env.VERCEL) {
  try { require('dotenv').config({ path: '.env.local' }); } catch { }
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
        subscriptions: data.subscriptions || {},
        portfolios: data.portfolios || {}
      };
    } catch (e) {
      return { watchlists: {}, subscriptions: {}, portfolios: {} };
    }
  }
  if (!_fileCache) {
    try {
      _fileCache = fs.existsSync(DATA_FILE) ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) : null;
    } catch (e) { }
    if (!_fileCache) _fileCache = { watchlists: {}, subscriptions: {}, portfolios: {} };
  }
  if (!_fileCache.portfolios) _fileCache.portfolios = {};
  return _fileCache;
}

async function saveStore(data) {
  if (process.env.UPSTASH_REDIS_REST_URL) {
    try { await redisCmd('SET', 'stock-alarm-v1', JSON.stringify(data)); } catch (e) { }
    return;
  }
  _fileCache = data;
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); } catch (_) { }
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
      try { fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys)); } catch (_) { }
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

const YAHOO_FIELDS = [
  'regularMarketPrice', 'regularMarketChange', 'regularMarketChangePercent',
  'regularMarketVolume', 'regularMarketPreviousClose',
  'postMarketPrice', 'postMarketChange', 'postMarketChangePercent',
  'preMarketPrice', 'preMarketChange', 'preMarketChangePercent',
  'marketState', 'shortName', 'longName', 'currency',
].join(',');

async function fetchQuotesBatch(symbols) {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const { crumb, cookie } = await getYahooCrumb();
  const r = await _fetch(
    `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols.map(encodeURIComponent).join(',')}&crumb=${encodeURIComponent(crumb)}&fields=${YAHOO_FIELDS}&lang=ko-KR&region=KR`,
    { headers: { 'User-Agent': UA, 'Cookie': cookie }, timeout: 10000 }
  );
  if (!r.ok) throw new Error(`Yahoo Finance ${r.status}`);
  const data = await r.json();
  return data.quoteResponse?.result || [];
}

// 국내 주식 실시간 가격: 네이버 금융 API (Yahoo는 15~20분 지연)
async function fetchNaverPrice(code) {
  try {
    const r = await _fetch(
      `https://m.stock.naver.com/api/stock/${code}/basic`,
      { timeout: 5000, headers: { Referer: 'https://m.stock.naver.com/' } }
    );
    if (!r.ok) return null;
    const d = await r.json();
    const toNum = s => Number(String(s ?? '').replace(/,/g, '')) || 0;
    const price  = toNum(d.closePrice);
    if (!price) return null;
    return {
      regularMarketPrice:         price,
      regularMarketChange:        toNum(d.compareToPreviousClosePrice),
      regularMarketChangePercent: parseFloat(String(d.fluctuationsRatio ?? '').replace(/[+%]/g, '')) || 0,
      regularMarketVolume:        toNum(d.accumulatedTradingVolume ?? d.tradeVolume),
    };
  } catch (_) { return null; }
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

    // 국내 주식은 네이버 금융 실시간 가격으로 보정 (Yahoo는 데이터 품질 불량)
    const krSymbols = results.filter(q => /\.(KS|KQ)$/i.test(q.symbol));
    await Promise.all(krSymbols.map(async q => {
      const code = q.symbol.replace(/\.(KS|KQ)$/i, '');
      const naver = await fetchNaverPrice(code);
      if (naver) {
        quotes[q.symbol].regularMarketPrice         = naver.regularMarketPrice;
        quotes[q.symbol].regularMarketChange        = naver.regularMarketChange;
        quotes[q.symbol].regularMarketChangePercent = naver.regularMarketChangePercent;
        if (naver.regularMarketVolume) quotes[q.symbol].regularMarketVolume = naver.regularMarketVolume;
      }
    }));
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
      const rawName = KR_STOCKS_MAP.get(symbol) || q.shortName || item.name || symbol;
      const name = rawName.replace(/^\(주\)\s*/g, '').replace(/\s*주식회사\s*$/g, '').trim() || rawName;
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
let KR_STOCKS_MAP = new Map();
try {
  const krData = require('./kr-stocks.json');
  KR_STOCKS = krData.map(s => {
    let exchange = 'KSC';
    if (s.s.endsWith('.KQ')) exchange = 'KOQ';
    else if (!s.s.includes('.')) exchange = 'NMS';
    
    return {
      symbol: s.s, shortname: s.n, longname: s.n,
      exchange,
      quoteType: 'EQUITY'
    };
  });
  KR_STOCKS.forEach(s => KR_STOCKS_MAP.set(s.symbol, s.shortname));
} catch (e) {
  console.error('Failed to load kr-stocks.json:', e);
}

// 주요 미국/해외 종목 한국어 표시명
const US_NAMES = new Map([
  // 빅테크
  ['AAPL',   '애플'],
  ['MSFT',   '마이크로소프트'],
  ['GOOGL',  '알파벳 A'],
  ['GOOG',   '알파벳 C'],
  ['AMZN',   '아마존'],
  ['META',   '메타'],
  ['NVDA',   '엔비디아'],
  ['TSLA',   '테슬라'],
  ['AVGO',   '브로드컴'],
  ['ORCL',   '오라클'],
  ['CRM',    '세일즈포스'],
  ['ADBE',   '어도비'],
  ['INTC',   '인텔'],
  ['AMD',    'AMD'],
  ['QCOM',   '퀄컴'],
  ['TXN',    '텍사스 인스트루먼트'],
  ['AMAT',   '어플라이드 머티리얼즈'],
  ['MU',     '마이크론'],
  ['ARM',    'ARM홀딩스'],
  ['ASML',   'ASML'],
  ['TSM',    'TSMC'],
  ['SMCI',   '슈퍼마이크로'],
  // 금융
  ['BRK-B',  '버크셔 해서웨이 B'],
  ['BRK-A',  '버크셔 해서웨이 A'],
  ['JPM',    'JP모건'],
  ['BAC',    '뱅크오브아메리카'],
  ['WFC',    '웰스파고'],
  ['GS',     '골드만삭스'],
  ['MS',     '모건스탠리'],
  ['V',      '비자'],
  ['MA',     '마스터카드'],
  ['PYPL',   '페이팔'],
  // 소비재·유통
  ['AMZN',   '아마존'],
  ['WMT',    '월마트'],
  ['COST',   '코스트코'],
  ['MCD',    '맥도날드'],
  ['SBUX',   '스타벅스'],
  ['NKE',    '나이키'],
  ['TGT',    '타겟'],
  ['HD',     '홈디포'],
  // 헬스케어
  ['JNJ',    '존슨앤존슨'],
  ['LLY',    '일라이 릴리'],
  ['PFE',    '화이자'],
  ['MRNA',   '모더나'],
  ['ABBV',   '애브비'],
  ['UNH',    '유나이티드헬스'],
  ['BMY',    '브리스톨마이어스'],
  ['MRK',    '머크'],
  // 에너지·산업
  ['XOM',    '엑슨모빌'],
  ['CVX',    '셰브론'],
  ['GE',     'GE'],
  ['BA',     '보잉'],
  ['CAT',    '캐터필러'],
  ['RTX',    '레이시온'],
  ['LMT',    '록히드마틴'],
  // 통신·미디어
  ['NFLX',   '넷플릭스'],
  ['DIS',    '디즈니'],
  ['SPOT',   '스포티파이'],
  ['T',      'AT&T'],
  ['VZ',     '버라이즌'],
  // ETF
  ['SPY',    'S&P500 ETF'],
  ['QQQ',    '나스닥100 ETF'],
  ['TQQQ',   '나스닥100 3X'],
  ['SQQQ',   '나스닥100 인버스3X'],
  ['SOXL',   '반도체 3X ETF'],
  ['SOXS',   '반도체 인버스3X'],
  ['VTI',    '전미국 ETF'],
  ['VOO',    'S&P500 ETF(VOO)'],
  ['IVV',    'S&P500 ETF(IVV)'],
  ['ARKK',   'ARK 혁신 ETF'],
  ['GLD',    '금 ETF'],
  ['SLV',    '은 ETF'],
  ['TLT',    '미국채20년 ETF'],
  ['BIL',    '미국채1-3개월 ETF'],
]);

app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ quotes: [] });

  let results = [];
  const resultsSet = new Set();
  
  // 1. Google Finance Autocomplete API (실제 사이트 검색 로직)
  const PRIMARY_EXCHANGES = new Set(['NASDAQ','NYSE','NYSEARCA','AMEX','OTC','KRX','KOSDAQ']);
  try {
    const gfRes = await _fetch(`https://www.google.com/complete/search?client=finance-immersive&q=${encodeURIComponent(q)}`, { timeout: 5000 });
    const gfText = await gfRes.text();
    const match = gfText.match(/window\.google\.ac\.h\((.*)\)/);
    if (match) {
      const data = JSON.parse(match[1]);
      if (data[1] && Array.isArray(data[1])) {
        data[1].forEach(item => {
          if (item[3] && item[3].t && item[3].x) {
            const t = item[3].t;
            const x = item[3].x;
            const c = item[3].c;

            if (!PRIMARY_EXCHANGES.has(x)) return;

            // Yahoo Finance symbol 변환
            let symbol = t;
            if (x === 'KRX') {
              const krLocal = KR_STOCKS.find(s => s.symbol.startsWith(t));
              if (krLocal) symbol = krLocal.symbol;
              else symbol = t + '.KS';
            } else if (x === 'KOSDAQ') {
              symbol = t + '.KQ';
            }

            if (!resultsSet.has(symbol)) {
              const mappedName = KR_STOCKS_MAP.get(symbol);
              const displayName = mappedName || c || t;
              results.push({
                symbol,
                shortname: displayName,
                longname: displayName,
                exchange: x === 'KRX' || x === 'KOSDAQ' ? (symbol.endsWith('.KQ') ? 'KOQ' : 'KSC') : x,
                quoteType: 'EQUITY'
              });
              resultsSet.add(symbol);
            }
          }
        });
      }
    }
  } catch (e) {
    console.warn('Google Finance search failed:', e.message);
  }

  // 2. 한국어 검색이고 결과가 부족하면 Naver Stock Autocomplete API로 검색
  if (/[가-힣]/.test(q) && results.length < 5) {
    try {
      const naverRes = await _fetch(
        `https://ac.stock.naver.com/ac?q=${encodeURIComponent(q)}&target=stock%2Cipo%2Cindex%2Cetf`,
        { timeout: 5000, headers: { Referer: 'https://finance.naver.com/' } }
      );
      const naverData = await naverRes.json();
      (naverData?.items || []).forEach(item => {
        if (!item.code || !item.typeCode) return;
        let symbol, exchange, quoteType = 'EQUITY';
        if (item.nationCode === 'KOR' && /^\d{6}$/.test(item.code)) {
          const isKosdaq = item.typeCode === 'KOSDAQ';
          const isEtf = item.typeCode === 'ETF';
          symbol = item.code + (isKosdaq ? '.KQ' : '.KS');
          exchange = isKosdaq ? 'KOQ' : 'KSC';
          if (isEtf) quoteType = 'ETF';
        } else if (PRIMARY_EXCHANGES.has(item.typeCode)) {
          symbol = item.code;
          exchange = item.typeCode;
        } else {
          return;
        }
        if (!resultsSet.has(symbol)) {
          const mappedName = KR_STOCKS_MAP.get(symbol) || item.name;
          results.push({ symbol, shortname: mappedName, longname: mappedName, exchange, quoteType });
          resultsSet.add(symbol);
        }
      });
    } catch (e) {
      console.warn('Naver stock search failed:', e.message);
    }
  }

  // 3. 만약 영어 검색이거나 부족하면 Yahoo Finance Search도 병행
  if (!/[\uAC00-\uD7A3]/.test(q) || results.length === 0) {
    try {
      const r = await _fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&lang=ko-KR&region=KR`, { timeout: 5000 });
      const data = await r.json();
      (data.quotes || []).forEach(quote => {
        if (!resultsSet.has(quote.symbol)) {
          const krName = KR_STOCKS_MAP.get(quote.symbol) || US_NAMES.get(quote.symbol);
          results.push(krName ? { ...quote, shortname: krName, longname: krName } : quote);
          resultsSet.add(quote.symbol);
        }
      });
    } catch (_) {}
  }

  res.json({ quotes: results.slice(0, 10) });
});

app.get('/api/quote', async (req, res) => {
  try {
    const symbols = req.query.symbols.split(',');
    const yahooResult = await fetchQuotesBatch(symbols);

    const enriched = await Promise.all(yahooResult.map(async q => {
      // 한글명 보강
      // 국내주식(KS/KQ)은 KR_STOCKS_MAP만 사용 — Yahoo 이름은 부정확한 경우가 많음
      const isKR = /\.(KS|KQ)$/i.test(q.symbol);
      const rawKorName = /[가-힣]/.test(q.shortName) ? q.shortName : (/[가-힣]/.test(q.longName) ? q.longName : null);
      const yahooKorName = rawKorName ? rawKorName.replace(/^\(주\)\s*/g, '').replace(/\s*주식회사\s*$/g, '').trim() || rawKorName : null;
      const korName = KR_STOCKS_MAP.get(q.symbol) || (isKR ? null : yahooKorName) || US_NAMES.get(q.symbol) || null;
      let result = { ...q, ...(korName ? { korName } : {}) };

      // 국내 주식(KS/KQ)은 네이버 금융 실시간 가격으로 덮어씀
      if (/\.(KS|KQ)$/i.test(q.symbol)) {
        const code = q.symbol.replace(/\.(KS|KQ)$/i, '');
        const naver = await fetchNaverPrice(code);
        if (naver) {
          result.regularMarketPrice         = naver.regularMarketPrice;
          result.regularMarketChange        = naver.regularMarketChange;
          result.regularMarketChangePercent = naver.regularMarketChangePercent;
          if (naver.regularMarketVolume) result.regularMarketVolume = naver.regularMarketVolume;
        }
      }

      return result;
    }));

    res.json({ quoteResponse: { result: enriched } });
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

app.get('/api/fxrates', async (req, res) => {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const FX_SYMBOLS = ['USDKRW=X', 'JPYKRW=X', 'EURKRW=X'];

  const extractRates = (results) => {
    const rates = {};
    (results || []).forEach(q => {
      if (q.symbol === 'USDKRW=X' && q.regularMarketPrice) rates.USD = q.regularMarketPrice;
      if (q.symbol === 'JPYKRW=X' && q.regularMarketPrice) rates.JPY = q.regularMarketPrice;
      if (q.symbol === 'EURKRW=X' && q.regularMarketPrice) rates.EUR = q.regularMarketPrice;
    });
    return rates;
  };

  // 1차: 크럼 없이 시도 (외환 심볼은 인증 없이도 동작하는 경우가 많음)
  try {
    const r = await _fetch(
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${FX_SYMBOLS.map(encodeURIComponent).join(',')}&fields=regularMarketPrice`,
      { headers: { 'User-Agent': UA }, timeout: 8000 }
    );
    if (r.ok) {
      const data = await r.json();
      const rates = extractRates(data.quoteResponse?.result);
      if (Object.keys(rates).length >= 1) return res.json({ rates, source: 'yahoo-direct' });
    }
  } catch (_) { }

  // 2차: 크럼 인증 방식으로 폴백
  try {
    const results = await fetchQuotesBatch(FX_SYMBOLS);
    const rates = extractRates(results);
    if (Object.keys(rates).length >= 1) return res.json({ rates, source: 'yahoo-crumb' });
  } catch (_) { }

  res.status(502).json({ error: 'exchange rate fetch failed' });
});

// ── News (Google News RSS per portfolio holding) ───────────────────────────
app.get('/api/news', async (req, res) => {
  const { clientId, symbol, name } = req.query;

  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  // 단일 종목 모드: symbol + name이 직접 전달된 경우
  let queries;
  if (symbol && name) {
    queries = [{ symbol, name }];
  } else {
    if (!clientId) return res.json({ articles: [] });

    // 보유종목 이름 수집
    let portfolio = {};
    try {
      const store = await getStore();
      portfolio = store.portfolios?.[clientId] || {};
    } catch (_) {}
    if (!Object.keys(portfolio).length) return res.json({ articles: [] });

    // 종목별 검색어 수집 (한글명 우선, 없으면 심볼)
    queries = Object.values(portfolio).map(item => {
      const name = item.korName || item.name || item.symbol;
      return { symbol: item.symbol, name };
    });
  }

  // Google News RSS 병렬 fetch
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const fetchNewsFor = async ({ symbol, name }) => {
    try {
      // tbs=qdr:d : Google에서 지난 24시간 뉴스로 1차 제한
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(name)}&hl=ko&gl=KR&ceid=KR:ko&tbs=qdr:d`;
      const r = await _fetch(url, { timeout: 6000, headers: { 'User-Agent': UA } });
      const xml = await r.text();
      const items = [];
      const itemRe = /<item>([\s\S]*?)<\/item>/g;
      let m;
      while ((m = itemRe.exec(xml)) !== null) {
        const block = m[1];
        const get = (tag) => { const t = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(block); return t ? (t[1] || t[2] || '').trim() : ''; };
        const title   = get('title');
        const link    = get('link') || (/<link\/>([\s\S]*?)<\/link>/.exec(block)?.[1] || '').trim();
        const pubDate = get('pubDate');
        const source  = get('source') || (/<source[^>]+>([^<]+)<\/source>/.exec(block)?.[1] || '').trim();
        if (!title) continue;
        const ts = pubDate ? new Date(pubDate).getTime() : 0;
        // 2차: 파싱된 ts가 24시간 이내인 것만 수집
        if (!ts || isNaN(ts) || ts < cutoff) continue;
        items.push({ symbol, stockName: name, title, link: link || '', pubDate, source, ts });
      }
      // 날짜 필터 후 최신 5개
      return items.sort((a, b) => b.ts - a.ts).slice(0, 5);
    } catch (_) { return []; }
  };

  const results = await Promise.all(queries.map(fetchNewsFor));
  const seen = new Set();
  // 3차: 최종 취합 시 한 번 더 cutoff 검증
  const articles = results.flat()
    .filter(a => a.ts >= cutoff)
    .filter(a => { if (seen.has(a.title)) return false; seen.add(a.title); return true; })
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 40);

  res.json({ articles });
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
  } catch { }
}
