'use strict';

// ── Utilities ──────────────────────────────────────────────────────────────
function uid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function urlBase64ToUint8Array(base64) {
  const pad = '='.repeat((4 - base64.length % 4) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

function formatPrice(price, currency = 'USD') {
  if (!price && price !== 0) return '—';
  if (currency === 'KRW' || currency === 'JPY') {
    return new Intl.NumberFormat('ko-KR', {
      style: 'currency', currency,
      maximumFractionDigits: 0
    }).format(price);
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency,
    minimumFractionDigits: 2, maximumFractionDigits: 2
  }).format(price);
}

function formatPriceInput(price, currency = 'USD') {
  if (!price && price !== 0) return '—';
  if (currency === 'KRW' || currency === 'JPY') {
    return new Intl.NumberFormat('ko-KR').format(price);
  }
  return Number(price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function timeAgo(ts) {
  if (!ts) return '';
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return '방금 전';
  if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}시간 전`;
  return `${Math.floor(sec / 86400)}일 전`;
}

function isLandscape() {
  return window.matchMedia('(orientation: landscape)').matches;
}

function getMarketStatus() {
  const now = new Date();
  // Get KST time
  const kstOffset = 9 * 60;
  const kst = new Date(now.getTime() + (now.getTimezoneOffset() + kstOffset) * 60000);
  const day = kst.getDay(); // 0:Sun, 1:Mon... 6:Sat
  const hh = kst.getHours();
  const mm = kst.getMinutes();
  const hhmm = hh * 100 + mm;

  let kr = '장마감';
  if (day >= 1 && day <= 5) {
    if (hhmm >= 900 && hhmm < 1530) kr = '장중';
    else if (hhmm < 900) kr = '장전';
  }

  // US Market (KST approx)
  // DST check (approx: Mar to Nov)
  const month = kst.getMonth() + 1;
  const isDST = month > 3 && month < 11;
  const usStart = isDST ? 2230 : 2330;
  const usEnd = isDST ? 500 : 600;

  let us = '장마감';
  // US market is open Mon-Fri (US time)
  // KST: Mon night to Sat morning
  const isOpenTime = (hhmm >= usStart || hhmm < usEnd);
  const isMarketDay = (day === 1 && hhmm >= usStart) || (day >= 2 && day <= 5) || (day === 6 && hhmm < usEnd);
  
  if (isMarketDay && isOpenTime) us = '장중';
  else if (isMarketDay && hhmm < usStart && hhmm > 600) us = '장전';

  return { kr, us };
}

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  clientId: localStorage.getItem('clientId') || (() => { const id = uid(); localStorage.setItem('clientId', id); return id; })(),
  watchlist: {},
  prices: {},
  loading: false,
  lastUpdated: null,
  theme: localStorage.getItem('theme') || 'dark',
  notifStatus: 'unknown',
  swReg: null,
  currentTab: 'home',
  searchResults: [],
  searching: false,
  fetchingPrices: false,
  installPrompt: null,
  notifBannerClosed: false,
  installBannerClosed: false,
  portfolio: {},
  portfolioPrices: {},
  portfolioSearchResults: [],
  portfolioSearchQ: '',
  portfolioSearching: false,
  portfolioFetchingPrices: false,
  fxRates: {},
  fxRatesUpdatedAt: null,
  expandedPortfolioCards: new Set(),
  summaryExpanded: false,
  summaryGroupExpanded: {},
  news: [],
  newsLoading: false,
  newsLoaded: false,
  newsFilter: null,  // { symbol, name } 또는 null(전체)
  portfolioSort: { domestic: 'gainPct', foreign: 'gainPct' },
  portfolioCollapsed: { domestic: false, foreign: false },
  portfolioUpdatedAt: null,
  sparklines: {},
  sparklinesUpdatedAt: null,
  supplyData: {},
  watchlistSearchResults: [],
  watchlistSearchQ: '',
  watchlistSearching: false,
  watchlistFetchingPrices: false,
  marketData: null,
  marketTop: null,
  volumeSpikes: null,
  marketLoading: false,
  marketLastUpdated: null,
  userName: localStorage.getItem('userName') || '사용자',
  domesticExchange: localStorage.getItem('domesticExchange') || 'KRX', // KRX, NXT
  importStocks: [],
};

// ── API ────────────────────────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Client-Id': state.clientId, ...opts.headers };
  const res = await fetch(path, { ...opts, headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadWatchlist() {
  try {
    const data = await apiFetch('/api/watchlist');
    if (data && !data.error) {
      state.watchlist = data;
    } else {
      throw new Error(data?.error || 'load error');
    }
  } catch {
    try {
      const cached = localStorage.getItem('watchlist');
      if (cached) state.watchlist = JSON.parse(cached);
    } catch (_) {}
  }
  // Sanitize: remove nulls or items without symbols
  for (const key in state.watchlist) {
    if (!state.watchlist[key] || !state.watchlist[key].symbol) {
      delete state.watchlist[key];
    }
  }
  localStorage.setItem('watchlist', JSON.stringify(state.watchlist));
}

async function loadPrices() {
  const symbols = Object.keys(state.watchlist);
  if (!symbols.length) return;
  try {
    const data = await apiFetch(`/api/quote?symbols=${symbols.join(',')}`);
    state.prices = {};
    (data.quoteResponse?.result || []).forEach(q => { state.prices[q.symbol] = q; });
    state.lastUpdated = Date.now();
    localStorage.setItem('prices', JSON.stringify({ data: state.prices, ts: state.lastUpdated }));
  } catch {
    const cached = localStorage.getItem('prices');
    if (cached) {
      const { data, ts } = JSON.parse(cached);
      state.prices = data || {};
      state.lastUpdated = ts || null;
    }
  }
}

async function saveStock(symbol, name, alertPrice, targetPrice, currency) {
  const item = { symbol, name, alertPrice: alertPrice || null, targetPrice: targetPrice || null, currency };
  await apiFetch('/api/watchlist', { method: 'POST', body: JSON.stringify(item) });
  state.watchlist[symbol] = item;
  localStorage.setItem('watchlist', JSON.stringify(state.watchlist));
}

async function deleteStock(symbol) {
  await apiFetch(`/api/watchlist/${encodeURIComponent(symbol)}`, { method: 'DELETE' });
  delete state.watchlist[symbol];
  delete state.prices[symbol];
  localStorage.setItem('watchlist', JSON.stringify(state.watchlist));
}

async function loadPortfolio() {
  try {
    const data = await apiFetch('/api/portfolio');
    if (data && !data.error) {
      state.portfolio = data;
    } else {
      throw new Error(data?.error || 'load error');
    }
  } catch {
    try {
      const cached = localStorage.getItem('portfolio');
      if (cached) state.portfolio = JSON.parse(cached);
    } catch (_) {}
  }
  for (const key in state.portfolio) {
    if (!state.portfolio[key] || !state.portfolio[key].symbol) delete state.portfolio[key];
  }
  localStorage.setItem('portfolio', JSON.stringify(state.portfolio));
}

async function loadPortfolioPrices() {
  const symbols = Object.keys(state.portfolio);
  if (!symbols.length) return;
  try {
    const data = await apiFetch(`/api/quote?symbols=${symbols.join(',')}`);
    (data.quoteResponse?.result || []).forEach(q => { state.portfolioPrices[q.symbol] = q; });
    state.portfolioUpdatedAt = Date.now();
    localStorage.setItem('portfolioPrices', JSON.stringify(state.portfolioPrices));
    localStorage.setItem('portfolioUpdatedAt', String(state.portfolioUpdatedAt));
  } catch {
    try {
      const cached = localStorage.getItem('portfolioPrices');
      if (cached) state.portfolioPrices = JSON.parse(cached);
      const ts = localStorage.getItem('portfolioUpdatedAt');
      if (ts) state.portfolioUpdatedAt = Number(ts);
    } catch (_) {}
  }
}

async function fetchFxRates() {
  try {
    const data = await apiFetch('/api/fxrates');
    if (data.rates && Object.keys(data.rates).length) {
      Object.assign(state.fxRates, data.rates);
      state.fxRatesUpdatedAt = Date.now();
    }
  } catch (_) {}
}

async function fetchSupplyData() {
  // 국내 보유종목(KS/KQ)에 대해서만 외인/기관 수급 데이터 조회
  const krSymbols = Object.keys(state.portfolio).filter(s => /\.(KS|KQ)$/i.test(s));
  if (!krSymbols.length) return;
  await Promise.all(krSymbols.map(async sym => {
    const code = sym.replace(/\.(KS|KQ)$/i, '');
    try {
      const data = await apiFetch(`/api/supply?code=${code}`);
      if (data && !data.error) state.supplyData[sym] = data;
    } catch (_) {}
  }));
}

async function savePortfolioItem(symbol, name, buyPrice, qty, currency, broker) {
  const item = { symbol, name, buyPrice, qty, currency, ...(broker ? { broker } : {}) };
  await apiFetch('/api/portfolio', { method: 'POST', body: JSON.stringify(item) });
  state.portfolio[symbol] = item;
  localStorage.setItem('portfolio', JSON.stringify(state.portfolio));
}

async function deletePortfolioItem(symbol) {
  await apiFetch(`/api/portfolio/${encodeURIComponent(symbol)}`, { method: 'DELETE' });
  delete state.portfolio[symbol];
  delete state.portfolioPrices[symbol];
  localStorage.setItem('portfolio', JSON.stringify(state.portfolio));
}


// ── Push Notifications ─────────────────────────────────────────────────────
async function requestPushPermission() {
  if (!('Notification' in window)) { showToast('이 브라우저는 알림을 지원하지 않습니다'); return; }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { showToast('알림 권한이 거부되었습니다'); return; }
  await subscribePush();
  updateNotifStatus();
  renderBanners();
  showToast('🔔 알림이 활성화되었습니다');
}

async function subscribePush() {
  if (!state.swReg) return;
  try {
    const { publicKey } = await apiFetch('/api/vapidPublicKey');
    const sub = await state.swReg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });
    await apiFetch('/api/subscribe', { method: 'POST', body: JSON.stringify(sub) });
    state.notifStatus = 'active';
  } catch (e) {
    console.error('Push subscribe failed:', e);
  }
}

async function unsubscribePush() {
  if (!state.swReg) return;
  try {
    const sub = await state.swReg.pushManager.getSubscription();
    if (sub) {
      await apiFetch('/api/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) });
      await sub.unsubscribe();
    }
    state.notifStatus = 'denied';
    updateNotifStatus();
    renderBanners();
    showToast('알림이 비활성화되었습니다');
  } catch (e) {
    console.error('Unsubscribe failed:', e);
  }
}

async function updateNotifStatus() {
  if (!('Notification' in window)) { state.notifStatus = 'unsupported'; return; }
  if (Notification.permission === 'denied') { state.notifStatus = 'denied'; return; }
  if (Notification.permission !== 'granted') { state.notifStatus = 'default'; return; }
  if (!state.swReg) { state.notifStatus = 'default'; return; }
  const sub = await state.swReg.pushManager.getSubscription();
  state.notifStatus = sub ? 'active' : 'default';
}

// ── Rendering ──────────────────────────────────────────────────────────────
function renderBanners() {
  const notifBanner = document.getElementById('notif-banner');
  const installBanner = document.getElementById('install-banner');
  if (!notifBanner || !installBanner) return;

  // Notification banner
  if (state.notifStatus === 'default' && !state.notifBannerClosed) {
    notifBanner.classList.remove('hidden');
  } else {
    notifBanner.classList.add('hidden');
  }

  // Install banner — Android: beforeinstallprompt / iOS: Safari share guide
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  const isStandalone = window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
  const canShowInstall = !isStandalone && !state.installBannerClosed &&
    (state.installPrompt || isIOS);
  if (canShowInstall) {
    installBanner.classList.remove('hidden');
  } else {
    installBanner.classList.add('hidden');
  }
}

function getChangeClass(pct) {
  if (!pct && pct !== 0) return 'flat';
  return pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
}

function getChangeStr(pct) {
  if (!pct && pct !== 0) return '';
  const icon = pct > 0 ? '<i class="ph ph-caret-up"></i>' : pct < 0 ? '<i class="ph ph-caret-down"></i>' : '';
  return `${icon} ${Math.abs(pct).toFixed(2)}%`;
}

function formatVolume(vol) {
  if (!vol) return '';
  if (vol >= 1e9) return (vol / 1e9).toFixed(1) + 'B';
  if (vol >= 1e6) return (vol / 1e6).toFixed(1) + 'M';
  if (vol >= 1e3) return (vol / 1e3).toFixed(0) + 'K';
  return vol.toLocaleString();
}

function formatVolumeKr(vol) {
  if (!vol) return '';
  const n = typeof vol === 'string' ? parseInt(vol.replace(/,/g, ''), 10) : vol;
  if (isNaN(n)) return vol;
  if (n >= 1e8) return (n / 1e8).toFixed(1) + '억주';
  if (n >= 1e4) return Math.floor(n / 1e4).toLocaleString() + '만주';
  return n.toLocaleString() + '주';
}

function buildSparklineSvg(closes, h = 22, full = false, mini = false) {
  if (!closes || closes.length < 2) return '';
  const VW = mini ? 18 : (full ? 300 : 64);
  const pad = mini ? 1 : 2;
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || 1;
  const pts = closes.map((c, i) => {
    const x = pad + (i / (closes.length - 1)) * (VW - pad * 2);
    const y = pad + (1 - (c - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const isUp = closes[closes.length - 1] >= closes[0];
  const color = isUp ? 'var(--stock-up)' : 'var(--stock-down)';
  const wAttr = full ? 'width="100%"' : `width="${VW}"`;
  const sw = mini ? '1.2' : (full ? '2.5' : '1.5');
  const cls = mini ? 'sparkline mini' : (full ? 'sparkline sparkline-detail' : 'sparkline');
  return `<svg class="${cls}" viewBox="0 0 ${VW} ${h}" ${wAttr} height="${h}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function buildSupportSparkSvg(closes) {
  if (!closes || closes.length < 2) return '';
  const h = 26, w = 52, pad = 2;
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || 1;
  const toY = v => (pad + (1 - (v - min) / range) * (h - pad * 2)).toFixed(1);
  const pts = closes.map((c, i) => {
    const x = (pad + (i / (closes.length - 1)) * (w - pad * 2)).toFixed(1);
    return `${x},${toY(c)}`;
  }).join(' ');
  const supportY = toY(min);
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none" style="display:block">
    <polyline points="${pts}" fill="none" stroke="var(--stock-down)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <line x1="${pad}" y1="${supportY}" x2="${w - pad}" y2="${supportY}" stroke="#f0c040" stroke-width="1" stroke-dasharray="2,2" opacity="0.85"/>
  </svg>`;
}

async function loadSparklines() {
  const symbols = [...new Set([...Object.keys(state.watchlist), ...Object.keys(state.portfolio)])];
  if (!symbols.length) return;
  if (state.sparklinesUpdatedAt && Object.keys(state.sparklines).length && Date.now() - state.sparklinesUpdatedAt < 4 * 60 * 60 * 1000) return;
  try {
    const data = await apiFetch(`/api/spark?symbols=${symbols.join(',')}`);
    if (data.result && Object.keys(data.result).length) {
      state.sparklines = data.result;
      state.sparklinesUpdatedAt = Date.now();
      localStorage.setItem('sparklines_v3', JSON.stringify({ data: state.sparklines, ts: state.sparklinesUpdatedAt }));
      if (state.currentTab === 'home') renderHome();
      if (state.currentTab === 'portfolio') renderPortfolioHoldings();
    }
  } catch (_) {}
}


function renderStockCard(item) {
  if (!item || !item.symbol) return '';
  const q = state.prices[item.symbol];
  const price = q?.regularMarketPrice;
  const pct = q?.regularMarketChangePercent;
  const change = q?.regularMarketChange;
  const volume = q?.regularMarketVolume;
  const currency = q?.currency || item.currency || 'USD';

  const atAlert = item.alertPrice && price && price <= item.alertPrice;
  const atTarget = item.targetPrice && price && price >= item.targetPrice;

  const changeClass = getChangeClass(pct);

  let badge = '';
  if (atTarget) badge = `<div class="reached-badge target"><i class="ph-fill ph-target"></i> 목표가 도달</div>`;
  else if (atAlert) badge = `<div class="reached-badge alert"><i class="ph-fill ph-bell-simple-ringing"></i> 관심가 도달</div>`;

  const cardClass = ['stock-card', atAlert ? 'alert-reached' : '', atTarget ? 'target-reached' : ''].filter(Boolean).join(' ');

  const volStr = formatVolume(volume);
  const metaStr = [item.symbol, volStr ? `거래량 ${volStr}` : ''].filter(Boolean).join(' · ');

  const changeSign = change > 0 ? '+' : '';
  const changeAmtStr = change != null ? `${changeSign}${formatPrice(change, currency)}` : '';
  const pctDisplayStr = pct != null ? `(${pct > 0 ? '+' : ''}${pct.toFixed(2)}%)` : '';

  const hasTargets = item.alertPrice || item.targetPrice;
  const targetsHtml = hasTargets ? `
    <div class="stock-targets">
      <div class="target-badge alert ${!item.alertPrice ? 'unset' : ''}">
        <div class="target-badge-label">관심가</div>
        <div class="target-badge-value">${item.alertPrice ? formatPrice(item.alertPrice, currency) : '미설정'}</div>
      </div>
      <div class="target-badge goal ${!item.targetPrice ? 'unset' : ''}">
        <div class="target-badge-label">목표가</div>
        <div class="target-badge-value">${item.targetPrice ? formatPrice(item.targetPrice, currency) : '미설정'}</div>
      </div>
    </div>` : '';

  return `
  <div class="${cardClass}" data-symbol="${item.symbol}" onclick="handleCardTap('${item.symbol}')">
    <div class="stock-card-main">
      ${badge}
      <div class="mts-row">
        <div class="mts-info">
          <div class="mts-name-row">
            <span class="stock-name">${item.name || q?.korName || item.symbol}</span>
          </div>
          <div class="mts-meta">${metaStr}</div>
        </div>
        <div class="mts-price-col">
          <div class="stock-price">${price ? formatPrice(price, currency) : '—'}</div>
          <div class="mts-change-row">
            <span class="${changeClass}">${changeAmtStr}</span>
            <span class="${changeClass}">${pctDisplayStr}</span>
          </div>
        </div>
        <button class="mts-order-btn" onclick="event.stopPropagation()">주문</button>
      </div>
      ${targetsHtml}
    </div>
    <div class="card-actions">
      <button class="card-btn edit" onclick="openEditModal(event,'${item.symbol}')"><i class="ph ph-pencil-simple"></i></button>
      <button class="card-btn del" onclick="confirmDelete(event,'${item.symbol}')"><i class="ph ph-trash"></i></button>
    </div>
  </div>`;
}

function renderHome() {
  const list = document.getElementById('home-list');
  if (!list) return;
  // Error check: state.watchlist might be an error object or empty
  const items = (state.watchlist && typeof state.watchlist === 'object' && !state.watchlist.error) ? Object.values(state.watchlist) : [];

  if (state.loading) {
    list.innerHTML = [1, 2, 3].map(() => `<div class="skeleton skeleton-card"></div>`).join('');
    return;
  }

  if (!items.length) {
    list.innerHTML = `
      <div class="empty">
        <div class="empty-icon"><i class="ph ph-trend-up"></i></div>
        <div class="empty-title">관심 종목이 없습니다</div>
        <div class="empty-sub">검색에서 종목을 추가하면<br>여기에 표시됩니다</div>
        <button class="btn-primary" onclick="document.getElementById('home-search-input')?.focus()">종목 검색하기</button>
      </div>`;
    return;
  }

  const updated = state.lastUpdated
    ? `<div class="last-updated">마지막 업데이트: ${timeAgo(state.lastUpdated)}</div>`
    : '';
  list.innerHTML = updated + items
    .filter(item => item && item.symbol) // Only valid items
    .map(item => renderStockCard(item))
    .join('');
}

// ── Biometric Lock ─────────────────────────────────────────────────────────

function isBiometricSupported() {
  return !!(window.PublicKeyCredential && navigator.credentials?.create && navigator.credentials?.get);
}

function isBiometricEnabled() {
  return localStorage.getItem('biometricEnabled') === 'true' && !!localStorage.getItem('biometricCredId');
}

async function registerBiometric() {
  try {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const userId = crypto.getRandomValues(new Uint8Array(16));
    const credential = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: 'WillyStock', id: window.location.hostname },
        user: { id: userId, name: 'willystock-user', displayName: 'WillyStock' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
        timeout: 60000
      }
    });
    const credId = btoa(String.fromCharCode(...new Uint8Array(credential.rawId)));
    localStorage.setItem('biometricCredId', credId);
    localStorage.setItem('biometricEnabled', 'true');
    return true;
  } catch (e) {
    console.warn('Biometric register failed:', e);
    return false;
  }
}

async function authenticateBiometric() {
  try {
    const b64 = localStorage.getItem('biometricCredId');
    if (!b64) return false;
    const credId = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    await navigator.credentials.get({
      publicKey: {
        challenge,
        rpId: window.location.hostname,
        allowCredentials: [{ type: 'public-key', id: credId }],
        userVerification: 'required',
        timeout: 60000
      }
    });
    return true;
  } catch (e) {
    console.warn('Biometric auth failed:', e);
    return false;
  }
}

function showLockScreen() {
  if (document.getElementById('lock-overlay')) return;
  const el = document.createElement('div');
  el.id = 'lock-overlay';
  el.innerHTML = `
    <div class="lock-content">
      <div class="lock-logo"><i class="ph-fill ph-chart-line-up"></i></div>
      <div class="lock-app-name">WillyStock</div>
      <button class="lock-bio-btn" id="lock-bio-btn">
        <i class="ph ph-fingerprint"></i>
        <span>생체인증으로 잠금 해제</span>
      </button>
    </div>`;
  document.body.appendChild(el);
  document.getElementById('lock-bio-btn').addEventListener('click', tryBiometricUnlock);
}

function hideLockScreen() {
  const el = document.getElementById('lock-overlay');
  if (!el) return;
  el.classList.add('unlocking');
  setTimeout(() => el.remove(), 350);
}

async function tryBiometricUnlock() {
  const btn = document.getElementById('lock-bio-btn');
  if (btn) { btn.disabled = true; btn.querySelector('i').className = 'ph ph-circle-notch spinning'; }
  const ok = await authenticateBiometric();
  if (ok) {
    hideLockScreen();
  } else {
    if (btn) {
      btn.disabled = false;
      btn.querySelector('i').className = 'ph ph-fingerprint';
    }
    showToast('인증 실패. 다시 시도해주세요.');
  }
}

async function checkBiometricLock() {
  if (!isBiometricEnabled()) return;
  showLockScreen();
  await tryBiometricUnlock();
}

async function toggleBiometricLock() {
  if (isBiometricEnabled()) {
    localStorage.removeItem('biometricEnabled');
    localStorage.removeItem('biometricCredId');
    showToast('생체인증 잠금이 해제되었습니다');
    renderSettings();
  } else {
    showToast('생체인증을 등록해주세요...');
    const ok = await registerBiometric();
    if (ok) {
      showToast('✅ 생체인증 잠금이 설정되었습니다');
    } else {
      showToast('등록에 실패했습니다. 기기에서 생체인증을 지원하는지 확인해주세요.');
    }
    renderSettings();
  }
}

// 앱이 백그라운드에서 복귀할 때 잠금
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && isBiometricEnabled()) {
    showLockScreen();
    tryBiometricUnlock();
  }
});

function renderSettings() {
  const notifLabel = {
    active: '<span class="status-dot active"></span>활성화됨',
    default: '<span class="status-dot inactive"></span>비활성화',
    denied: '<span class="status-dot inactive"></span>차단됨',
    unsupported: '<span class="status-dot inactive"></span>미지원',
  }[state.notifStatus] || '—';

  document.getElementById('settings-content').innerHTML = `
    <div class="section-title">알림 설정</div>
    <div class="info-card">
      <div class="info-row">
        <div class="info-row-label"><i class="ph ph-bell info-row-icon"></i>푸시 알림</div>
        <button class="toggle ${state.notifStatus === 'active' ? 'on' : ''}"
          onclick="${state.notifStatus === 'active' ? 'unsubscribePush()' : 'requestPushPermission()'}"
          id="notif-toggle"></button>
      </div>
      <div class="info-row">
        <div class="info-row-label"><i class="ph ph-activity info-row-icon"></i>알림 상태</div>
        <div class="info-row-value">${notifLabel}</div>
      </div>
    </div>
    <div class="section-title">보안 설정</div>
    <div class="info-card">
      ${isBiometricSupported() ? `
      <div class="info-row">
        <div class="info-row-label"><i class="ph ph-fingerprint info-row-icon"></i>생체인증 잠금</div>
        <button class="toggle ${isBiometricEnabled() ? 'on' : ''}" onclick="toggleBiometricLock()"></button>
      </div>` : `
      <div class="info-row">
        <div class="info-row-label"><i class="ph ph-fingerprint info-row-icon"></i>생체인증 잠금</div>
        <div class="info-row-value" style="font-size:11px">미지원 기기</div>
      </div>`}
    </div>
    <div class="section-title">화면 설정</div>
    <div class="info-card">
      <div class="info-row">
        <div class="info-row-label"><i class="ph ph-moon info-row-icon"></i>다크 모드</div>
        <button class="toggle ${state.theme === 'dark' ? 'on' : ''}" onclick="toggleTheme()" id="theme-toggle"></button>
      </div>
    </div>
    <div class="section-title">앱 정보</div>
    <div class="info-card">
      <div class="info-row">
        <div class="info-row-label"><i class="ph ph-info info-row-icon"></i>WillyStock</div>
        <div class="info-row-value">v1.2.2</div>
      </div>
      <div class="info-row">
        <div class="info-row-label"><i class="ph ph-clock info-row-icon"></i>데이터 갱신</div>
        <div class="info-row-value">실시간 (1분단위)</div>
      </div>
      <div class="info-row">
        <div class="info-row-label"><i class="ph ph-stack info-row-icon"></i>관심 종목</div>
        <div class="info-row-value">${Object.keys(state.watchlist).length}개</div>
      </div>
    </div>
    <div class="section-title">보유종목 가져오기</div>
    <div class="info-card">
      <div style="padding:16px 16px 12px">
        <div style="font-size:12px;color:var(--text-sub);margin-bottom:14px;line-height:1.6">
          증권사 앱 보유종목 화면을 캡처한 이미지를<br>선택하면 AI가 종목·매수가·수량을 자동으로 읽어옵니다.
        </div>
        <input type="file" id="import-file-input" accept="image/*" capture="environment" style="display:none" onchange="handleImportFile(this)">
        <button class="btn-save" style="width:100%;justify-content:center;gap:8px" onclick="document.getElementById('import-file-input').click()">
          <i class="ph ph-upload-simple"></i> 스크린샷 선택
        </button>
        <div id="import-status" style="text-align:center;margin-top:10px;font-size:12px;color:var(--text-sub);min-height:18px"></div>
      </div>
    </div>
    <div class="section-title">iOS 안내</div>
    <div class="info-card">
      <div class="info-row" style="flex-direction:column;align-items:flex-start;gap:12px;padding:20px">
        <div class="info-row-label"><i class="ph ph-device-mobile info-row-icon"></i>홈 화면 추가 방법</div>
        <div style="font-size:13px;color:var(--text-sub);line-height:1.6">
          1. Safari 하단 <strong>공유</strong> 버튼(<i class="ph ph-export" style="color:var(--primary)"></i>)을 탭합니다.<br>
          2. 리스트를 스크롤하여 <strong>홈 화면에 추가</strong>를 선택합니다.<br>
          3. 우측 상단 <strong>추가</strong>를 탭하면 설치가 완료됩니다.
        </div>
      </div>
    </div>`;
}

// ── 스크린샷 가져오기 ──────────────────────────────────────────────────────────
function handleImportFile(input) {
  const file = input.files[0];
  if (!file) return;
  input.value = '';

  const setStatus = (msg) => {
    const el = document.getElementById('import-status');
    if (el) el.textContent = msg;
  };

  setStatus('이미지 분석 중…');

  // 이미지 리사이즈 후 base64 변환 (API 비용 절감)
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = async () => {
      // 최대 1200px로 축소
      const MAX = 1200;
      let { width: w, height: h } = img;
      if (w > MAX || h > MAX) {
        const r = Math.min(MAX / w, MAX / h);
        w = Math.round(w * r); h = Math.round(h * r);
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const b64 = canvas.toDataURL('image/jpeg', 0.85);

      try {
        const data = await apiFetch('/api/ocr-import', { method: 'POST', body: JSON.stringify({ image: b64 }) });
        if (data.error) throw new Error(data.error);
        if (!data.stocks?.length) throw new Error('종목을 인식하지 못했습니다');

        setStatus('');
        // 각 종목 심볼 검색 (병렬)
        const enriched = await Promise.all(data.stocks.map(async (s) => {
          try {
            const r = await apiFetch(`/api/search?q=${encodeURIComponent(s.name)}`);
            const best = r.quotes?.[0] || null;
            return { ...s, symbol: best?.symbol || null, resolvedName: best?.shortname || s.name, checked: true };
          } catch {
            return { ...s, symbol: null, resolvedName: s.name, checked: true };
          }
        }));

        state.importStocks = enriched;
        renderImportSheet();
        document.getElementById('import-overlay')?.classList.remove('hidden');
      } catch (err) {
        setStatus('오류: ' + err.message);
      }
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function renderImportSheet() {
  const wrap = document.getElementById('import-results');
  if (!wrap) return;
  const sub = document.getElementById('import-sheet-sub');
  const checkedCount = state.importStocks.filter(s => s.checked && s.symbol).length;
  if (sub) sub.textContent = `${state.importStocks.length}개 종목 인식 · ${checkedCount}개 추가 예정`;

  wrap.innerHTML = state.importStocks.map((s, i) => `
    <div class="import-row ${s.checked ? '' : 'import-row-off'}">
      <label class="import-check-wrap">
        <input type="checkbox" class="import-check" ${s.checked ? 'checked' : ''} onchange="toggleImportStock(${i}, this.checked)">
        <span class="import-check-box"></span>
      </label>
      <div class="import-row-body">
        <div class="import-row-top">
          <div class="import-name-wrap">
            <div class="import-resolved-name">${s.resolvedName}</div>
            ${s.symbol
              ? `<div class="import-symbol-badge">${s.symbol}</div>`
              : `<div class="import-symbol-badge unmatched">미매칭</div>`}
          </div>
        </div>
        <div class="import-row-inputs">
          <div class="import-field">
            <span class="import-field-label">매수가</span>
            <input type="number" class="import-field-input" value="${s.buyPrice || ''}" placeholder="0"
              oninput="updateImportStock(${i}, 'buyPrice', this.value)">
          </div>
          <div class="import-field">
            <span class="import-field-label">수량</span>
            <input type="number" class="import-field-input" value="${s.qty || ''}" placeholder="0"
              oninput="updateImportStock(${i}, 'qty', this.value)">
          </div>
        </div>
      </div>
    </div>
  `).join('');
}

function toggleImportStock(i, checked) {
  state.importStocks[i].checked = checked;
  const sub = document.getElementById('import-sheet-sub');
  const checkedCount = state.importStocks.filter(s => s.checked && s.symbol).length;
  if (sub) sub.textContent = `${state.importStocks.length}개 종목 인식 · ${checkedCount}개 추가 예정`;
}

function updateImportStock(i, field, val) {
  state.importStocks[i][field] = field === 'qty' ? Math.round(Number(val)) : Number(val);
}

async function confirmImportAll() {
  const toAdd = state.importStocks.filter(s => s.checked && s.symbol && s.buyPrice > 0 && s.qty > 0);
  if (!toAdd.length) { showToast('추가할 종목이 없습니다'); return; }

  const btn = document.getElementById('import-add-btn');
  if (btn) { btn.disabled = true; btn.textContent = '추가 중…'; }

  let added = 0;
  for (const s of toAdd) {
    try {
      const currency = /\.(KS|KQ)$/i.test(s.symbol) ? 'KRW' : 'USD';
      await savePortfolioItem(s.symbol, s.resolvedName, s.buyPrice, s.qty, currency, '');
      added++;
    } catch (_) {}
  }

  closeImportSheet();
  await loadPortfolioPrices();
  renderPortfolioHoldings();
  showToast(`${added}개 종목이 추가되었습니다`);
  switchTab('portfolio');
}

function closeImportSheet() {
  document.getElementById('import-overlay')?.classList.add('hidden');
  state.importStocks = [];
  const el = document.getElementById('import-status');
  if (el) el.textContent = '';
}

// ── Chart Modal ────────────────────────────────────────────────────────────
function openChartModal(code, name, market) {
  const isKospi  = market === 'KOSPI'  || /\.KS$/i.test(code);
  const isKosdaq = market === 'KOSDAQ' || /\.KQ$/i.test(code);
  const isKorean = isKospi || isKosdaq;

  // Yahoo Finance 심볼 (국내 주식 차트 데이터 요청용)
  let yahooSymbol;
  let displaySymbol;
  if (isKospi) {
    const raw = code.replace(/\.KS$/i, '');
    yahooSymbol  = `${raw}.KS`;
    displaySymbol = `KRX:${raw}`;
  } else if (isKosdaq) {
    const raw = code.replace(/\.KQ$/i, '');
    yahooSymbol  = `${raw}.KQ`;
    displaySymbol = `KOSDAQ:${raw}`;
  } else {
    displaySymbol = toTvSymbol(code);
  }

  document.getElementById('chart-stock-name').textContent = name || code;
  document.getElementById('chart-stock-sub').textContent = displaySymbol;
  document.getElementById('chart-tv-link').href =
    `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(displaySymbol)}`;

  document.getElementById('chart-overlay').classList.add('open');
  document.body.style.overflow = 'hidden';

  if (isKorean) {
    renderKrChart(yahooSymbol, 'chart-widget-wrap');
  } else {
    _spawnTvWidget(displaySymbol, 'chart-widget-wrap', false);
  }
}

function closeChartModal() {
  document.getElementById('chart-overlay').classList.remove('open');
  // 위젯 정리 (다음 오픈 시 새로 주입)
  document.getElementById('chart-widget-wrap').innerHTML = '';
  document.body.style.overflow = '';
}

// ── Modal ──────────────────────────────────────────────────────────────────
let modalData = {};

function openAddModal(symbol, name, currency) {
  const existing = state.watchlist[symbol];
  modalData = { symbol, name, currency, existing };

  const q = state.prices[symbol];
  const price = q?.regularMarketPrice;
  const cur = q?.currency || currency;

  document.getElementById('modal-title').textContent = existing ? '종목 수정' : '종목 추가';
  document.getElementById('modal-sub').textContent = existing ? '관심가와 목표가를 수정하세요' : '관심가와 목표가를 설정하세요';
  document.getElementById('modal-stock-name').textContent = name;
  document.getElementById('modal-stock-symbol').textContent = symbol;
  document.getElementById('modal-current-price').textContent = price ? formatPrice(price, cur) : '데이터 로딩 중...';

  const alertInput = document.getElementById('modal-alert-price');
  const targetInput = document.getElementById('modal-target-price');
  alertInput.value = existing?.alertPrice || '';
  targetInput.value = existing?.targetPrice || '';
  alertInput.placeholder = price ? `예: ${formatPriceInputPlain(price * 0.95, cur)}` : '숫자 입력';
  targetInput.placeholder = price ? `예: ${formatPriceInputPlain(price * 1.1, cur)}` : '숫자 입력';

  document.getElementById('modal-hint-alert').textContent = `현재가의 95%: ${price ? formatPrice(price * 0.95, cur) : '—'}`;
  document.getElementById('modal-hint-target').textContent = `현재가의 110%: ${price ? formatPrice(price * 1.1, cur) : '—'}`;

  document.getElementById('modal-overlay').classList.add('open');
}

function openEditModal(event, symbol) {
  event.stopPropagation();
  const item = state.watchlist[symbol];
  if (!item) return;
  openAddModal(symbol, item.name, item.currency);
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
  setTimeout(() => { modalData = {}; }, 300);
}

async function saveModal() {
  const alertPrice = parseFloat(document.getElementById('modal-alert-price').value.replace(/,/g, '')) || null;
  const targetPrice = parseFloat(document.getElementById('modal-target-price').value.replace(/,/g, '')) || null;
  const { symbol, name, currency, existing } = modalData;
  const q = state.prices[symbol];
  const cur = q?.currency || currency;
  try {
    await saveStock(symbol, name, alertPrice, targetPrice, cur);
  } catch {
    showToast('저장 중 오류가 발생했습니다');
    return;
  }
  closeModal();
  await loadPrices();
  renderHome();
  renderWatchlistSearch();
  if (state.currentTab === 'settings') renderSettings();
  showToast(existing ? '✅ 종목이 수정되었습니다' : '✅ 종목이 추가되었습니다');
}

async function confirmDelete(event, symbol) {
  event.stopPropagation();
  if (!confirm(`${state.watchlist[symbol]?.name || symbol} 종목을 삭제할까요?`)) return;
  try {
    await deleteStock(symbol);
    renderHome();
    showToast('종목이 삭제되었습니다');
  } catch {
    showToast('삭제 중 오류가 발생했습니다');
  }
}

let isSwiping = false;

function handleCardTap(symbol) {
  if (isSwiping) return;

  const card = document.querySelector(`.stock-card[data-symbol="${symbol}"]`);
  if (!card) return;

  if (card.classList.contains('swiped')) {
    card.classList.remove('swiped');
    if (currentSwipedCard === card) currentSwipedCard = null;
    return;
  }

  const item = state.watchlist[symbol];
  const q = state.prices[symbol];
  openChartModal(symbol, item?.name || q?.korName || symbol, null);
}

// ── Swipe Logic ────────────────────────────────────────────────────────────
let swipeStart = { x: 0, y: 0 };
let currentSwipedCard = null;
let swipeTimer = null;

function revealActions(card) {
  if (currentSwipedCard && currentSwipedCard !== card) {
    currentSwipedCard.classList.remove('swiped');
  }
  card.classList.add('swiped');
  currentSwipedCard = card;
  isSwiping = true;
  if (swipeTimer) clearTimeout(swipeTimer);
  swipeTimer = setTimeout(() => {
    if (currentSwipedCard) { currentSwipedCard.classList.remove('swiped'); currentSwipedCard = null; }
  }, 3000);
}

function hideActions(card) {
  card.classList.remove('swiped');
  if (currentSwipedCard === card) currentSwipedCard = null;
  isSwiping = true;
}

function setupSwipeForList(list) {
  if (!list) return;
  let activeCard = null;
  let mouseCard = null;

  list.addEventListener('touchstart', e => {
    const card = e.target.closest('.stock-card');
    activeCard = card || null;
    if (!card) return;
    swipeStart.x = e.touches[0].clientX;
    swipeStart.y = e.touches[0].clientY;
    isSwiping = false;
  }, { passive: true });

  list.addEventListener('touchend', e => {
    const card = activeCard;
    activeCard = null;
    if (!card) return;
    if (window.matchMedia('(orientation: landscape)').matches) return;
    const dx = swipeStart.x - e.changedTouches[0].clientX;
    const dy = Math.abs(swipeStart.y - e.changedTouches[0].clientY);
    if (dx > 30 && dy < 80) revealActions(card);
    else if (dx < -20 && card.classList.contains('swiped')) hideActions(card);
    if (isSwiping) setTimeout(() => { isSwiping = false; }, 300);
  }, { passive: true });

  list.addEventListener('touchcancel', () => { activeCard = null; }, { passive: true });

  list.addEventListener('mousedown', e => {
    const card = e.target.closest('.stock-card');
    mouseCard = card || null;
    if (!card) return;
    swipeStart.x = e.clientX;
    swipeStart.y = e.clientY;
  });
  document.addEventListener('mouseup', e => {
    const card = mouseCard;
    mouseCard = null;
    if (!card) return;
    if (window.matchMedia('(orientation: landscape)').matches) return;
    const dx = swipeStart.x - e.clientX;
    const dy = Math.abs(swipeStart.y - e.clientY);
    if (dx > 30 && dy < 80) revealActions(card);
    else if (dx < -20 && card.classList.contains('swiped')) hideActions(card);
    if (isSwiping) setTimeout(() => { isSwiping = false; }, 300);
  });
}

function setupSwipeEvents() {
  setupSwipeForList(document.getElementById('home-list'));
  setupSwipeForList(document.getElementById('portfolio-holdings'));
}

function formatPriceInputPlain(price, currency) {
  if (currency === 'KRW' || currency === 'JPY') return Math.round(price).toLocaleString();
  return price.toFixed(2);
}

// ── Portfolio Rendering ────────────────────────────────────────────────────
function getDisplayPrice(q) {
  if (!q) return null;
  const isPost = q.marketState === 'POST' && q.postMarketPrice;
  const isPre  = q.marketState === 'PRE'  && q.preMarketPrice;
  return isPost ? q.postMarketPrice : isPre ? q.preMarketPrice : (q.regularMarketPrice || null);
}

function getDisplayPct(q) {
  if (!q) return null;
  const isPost = q.marketState === 'POST' && q.postMarketPrice;
  const isPre  = q.marketState === 'PRE'  && q.preMarketPrice;
  return isPost ? (q.postMarketChangePercent ?? null)
       : isPre  ? (q.preMarketChangePercent  ?? null)
       : (q.regularMarketChangePercent ?? null);
}

function renderPortfolioSummary() {
  const items = Object.values(state.portfolio);
  if (!items.length) return '';

  // 국내(KRW) / 해외(non-KRW) 분리 집계
  // investedWithPrice: 가격이 있는 종목만 포함 (손익/수익률 계산 기준)
  const krw = { invested: 0, investedWithPrice: 0, current: 0, hasPrices: false, count: 0 };
  const foreign = { investedKrw: 0, investedKrwWithPrice: 0, currentKrw: 0, hasPrices: false, count: 0, byCurrency: {} };

  for (const item of items) {
    const q = state.portfolioPrices[item.symbol];
    const currency = q?.currency || item.currency || 'USD';
    const price = getDisplayPrice(q);
    const invested = (item.buyPrice || 0) * (item.qty || 0);
    const current = price ? price * item.qty : null;

    if (currency === 'KRW') {
      krw.count++;
      krw.invested += invested;
      if (current !== null) {
        krw.current += current;
        krw.investedWithPrice += invested;
        krw.hasPrices = true;
      }
    } else {
      foreign.count++;
      if (!foreign.byCurrency[currency]) foreign.byCurrency[currency] = { invested: 0, investedWithPrice: 0, current: 0, hasPrices: false };
      foreign.byCurrency[currency].invested += invested;
      const rate = state.fxRates[currency] || null;
      if (rate) foreign.investedKrw += invested * rate;
      if (current !== null) {
        foreign.byCurrency[currency].current += current;
        foreign.byCurrency[currency].investedWithPrice += invested;
        foreign.byCurrency[currency].hasPrices = true;
        if (rate) {
          foreign.currentKrw += current * rate;
          foreign.investedKrwWithPrice += invested * rate;
          foreign.hasPrices = true;
        }
      }
    }
  }

  // 전체 합산 (원화 기준) — 가격이 있는 종목만 투자금/평가금을 대응시켜 손익 계산
  const totalInvested = krw.investedWithPrice + foreign.investedKrwWithPrice;
  const totalCurrent  = (krw.hasPrices ? krw.current : 0) + (foreign.hasPrices ? foreign.currentKrw : 0);
  const hasTotal = krw.hasPrices || foreign.hasPrices;
  const totalGain = hasTotal ? totalCurrent - totalInvested : null;
  const totalGainPct = totalGain !== null && totalInvested > 0 ? (totalGain / totalInvested) * 100 : null;
  const tgc = totalGain !== null ? (totalGain >= 0 ? 'gain-up' : 'gain-down') : '';
  const tgs = totalGain !== null && totalGain >= 0 ? '+' : '';

  const statsGrid = (rows) => `<div class="psummary-stats">${rows.map(([label, val, cls]) =>
    `<div class="psummary-stat"><span class="psummary-stat-label">${label}</span><span class="psummary-stat-val${cls ? ' ' + cls : ''}">${val}</span></div>`
  ).join('')}</div>`;

  const summaryCol = (key, flag, label, count, totalStr, pctStr, gc, detailHtml) => {
    const isExp = !!(state.summaryGroupExpanded && state.summaryGroupExpanded[key]);
    return `
    <div class="psummary-col-wrap">
      <div class="psummary-col">
        <div class="psummary-col-top">
          <span class="psummary-col-flag">${flag}</span>
          <span class="psummary-col-label">${label}</span>
          <span class="psummary-col-count">${count}종목</span>
        </div>
        <div class="psummary-col-main">
          <span class="psummary-col-amount">${totalStr}</span>
          <div class="psummary-col-sub">
            <span class="psummary-col-pct ${gc}">${pctStr}</span>
          </div>
        </div>
        <button class="port-dots-btn" onclick="event.stopPropagation();toggleSummaryGroup('${key}')"><i class="ph ph-dots-three-vertical"></i></button>
      </div>
      <div class="psummary-group-detail${isExp ? ' expanded' : ''}" data-key="${key}">${detailHtml}</div>
    </div>`;
  };

  // 국내주식 컬럼 데이터
  let krwCol = '';
  if (krw.count > 0) {
    const gain = krw.hasPrices ? krw.current - krw.investedWithPrice : null;
    const gainPct = gain !== null && krw.investedWithPrice > 0 ? (gain / krw.investedWithPrice) * 100 : null;
    const gc = gain !== null ? (gain >= 0 ? 'gain-up' : 'gain-down') : '';
    const gs = gain !== null && gain >= 0 ? '+' : '';
    const detail = statsGrid([
      ['투자금액', formatPrice(krw.invested, 'KRW'), ''],
      ['평가금액', krw.hasPrices ? formatPrice(krw.current, 'KRW') : '—', ''],
      ['손익', gain !== null ? `${gs}${formatPrice(Math.abs(gain), 'KRW')}` : '—', gc],
      ['수익률', gainPct !== null ? `${gs}${gainPct.toFixed(1)}%` : '—', gc],
    ]);
    krwCol = summaryCol('KRW', '🇰🇷', '국내주식', krw.count,
      krw.hasPrices ? formatPrice(krw.current, 'KRW') : '—',
      gainPct !== null ? `${gs}${gainPct.toFixed(1)}%` : '—',
      gc, detail);
  }

  // 해외주식 컬럼 데이터
  let foreignCol = '';
  if (foreign.count > 0) {
    const gain = foreign.hasPrices ? foreign.currentKrw - foreign.investedKrwWithPrice : null;
    const gainPct = gain !== null && foreign.investedKrwWithPrice > 0 ? (gain / foreign.investedKrwWithPrice) * 100 : null;
    const gc = gain !== null ? (gain >= 0 ? 'gain-up' : 'gain-down') : '';
    const gs = gain !== null && gain >= 0 ? '+' : '';
    let detailHtml = '';
    for (const [currency, g] of Object.entries(foreign.byCurrency)) {
      const cgain = g.hasPrices ? g.current - g.investedWithPrice : null;
      const cgainPct = cgain !== null && g.investedWithPrice > 0 ? (cgain / g.investedWithPrice) * 100 : null;
      const cgc = cgain !== null ? (cgain >= 0 ? 'gain-up' : 'gain-down') : '';
      const cgs = cgain !== null && cgain >= 0 ? '+' : '';
      const rate = state.fxRates[currency];
      detailHtml += statsGrid([
        ['투자금액', formatPrice(g.invested, currency), ''],
        ['평가금액', g.hasPrices ? formatPrice(g.current, currency) : '—', ''],
        ['손익', cgain !== null ? `${cgs}${formatPrice(Math.abs(cgain), currency)}` : '—', cgc],
        ['수익률', cgainPct !== null ? `${cgs}${cgainPct.toFixed(1)}%` : '—', cgc],
      ]);
      if (rate && g.hasPrices) {
        const krwGain = cgain !== null ? cgain * rate : null;
        const krwGc = krwGain !== null ? (krwGain >= 0 ? 'gain-up' : 'gain-down') : '';
        detailHtml += `<div class="psummary-krw-row"><i class="ph ph-currency-circle-dollar"></i> ${currency} ₩${Math.round(rate).toLocaleString('ko-KR')} · ${formatPrice(g.current * rate, 'KRW')}${krwGain !== null ? ` <span class="${krwGc}">(${krwGain >= 0 ? '+' : ''}${formatPrice(Math.abs(krwGain), 'KRW')})</span>` : ''}</div>`;
      }
    }
    foreignCol = summaryCol('foreign', '🇺🇸', '해외주식', foreign.count,
      foreign.hasPrices ? formatPrice(foreign.currentKrw, 'KRW') : '—',
      gainPct !== null ? `${gs}${gainPct.toFixed(1)}%` : '—',
      gc, detailHtml);
  }

  const totalCount = items.length;
  const m = getMarketStatus();
  const updatedStr = (() => {
    if (!state.portfolioUpdatedAt) return '';
    const d = new Date(state.portfolioUpdatedAt);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${mm}/${dd} ${hh}:${min}`;
  })();

  return `
  <div class="portfolio-summary ${state.summaryExpanded ? 'expanded' : ''}">
    <div class="psummary-card">
      <div class="psummary-header-top">
        <div class="psummary-header-info">
          <span class="psummary-header-label">총 평가금액</span>
          <span class="psummary-header-badge">${totalCount}종목</span>
        </div>
        ${updatedStr ? `<span class="psummary-updated">${updatedStr} 갱신</span>` : ''}
      </div>
      <div class="psummary-header-amount">${hasTotal ? formatPrice(totalCurrent, 'KRW') : '—'}</div>
      
      <div class="psummary-header-footer">
        <div class="psummary-header-gain">
          <span class="${tgc}">${totalGain !== null ? `${tgs}${formatPrice(Math.abs(totalGain), 'KRW')}` : '—'}</span>
          <span class="psummary-header-pct ${tgc}">${totalGainPct !== null ? `${tgs}${totalGainPct.toFixed(1)}%` : ''}</span>
        </div>
        
        <div class="psummary-market-status">
          <span class="m-item kr">🇰🇷 ${m.kr}</span>
          <span class="m-item us">🇺🇸 ${m.us}</span>
        </div>
      </div>

      <button class="psummary-toggle-btn" onclick="event.stopPropagation();togglePortfolioSummary()">
        <span>${state.summaryExpanded ? '간단히 보기' : '자산 구성 상세'}</span>
        <i class="ph ph-caret-down"></i>
      </button>
      
      <div class="psummary-expand-body">
        <div class="psummary-divider"></div>
        <div class="psummary-rows">
          ${krwCol}${foreignCol}
        </div>
      </div>
    </div>
  </div>`;
}

// Wilder's smoothing RSI — closes 배열과 동일 길이, 앞은 null 패딩
function calcRSI(closes, period = 14) {
  const result = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return result;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period; avgLoss /= period;
  result[period] = 100 - 100 / (1 + avgGain / (avgLoss || 1e-10));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    result[i] = 100 - 100 / (1 + avgGain / (avgLoss || 1e-10));
  }
  return result;
}

// 상승 다이버전스: 가격 저점↓ + RSI 저점↑ (최근 60봉 내 swing low 2개 비교)
function detectBullishDivergence(closes, rsi) {
  const wing = 3, lookback = 60;
  const start = Math.max(wing, closes.length - lookback);
  const lows = [];
  for (let i = start; i < closes.length - wing; i++) {
    if (rsi[i] === null) continue;
    const leftOK  = closes.slice(i - wing, i).every(v => v >= closes[i]);
    const rightOK = closes.slice(i + 1, i + wing + 1).every(v => v >= closes[i]);
    if (leftOK && rightOK) lows.push({ price: closes[i], rsi: rsi[i] });
  }
  if (lows.length < 2) return false;
  const a = lows[lows.length - 2], b = lows[lows.length - 1];
  return b.price < a.price && b.rsi > a.rsi;
}

function renderPortfolioCard(item) {
  const q = state.portfolioPrices[item.symbol];
  const currency = q?.currency || item.currency || 'USD';
  const invested = (item.buyPrice || 0) * (item.qty || 0);
  const isKR = currency === 'KRW';

  // KRX (정규장) 주가
  const isPost = q?.marketState === 'POST' && q?.postMarketPrice;
  const isPre  = q?.marketState === 'PRE'  && q?.preMarketPrice;
  const krxPrice = isPost ? q.postMarketPrice  : isPre ? q.preMarketPrice  : q?.regularMarketPrice;
  const krxPct   = isPost ? q.postMarketChangePercent : isPre ? q.preMarketChangePercent : q?.regularMarketChangePercent;

  // NXT 데이터 처리
  const nxtPrice = q?.nxtPrice;
  const nxtPct = q?.nxtPct;
  const nxtChangeClass = getChangeClass(nxtPct);
  const nxtTriangle = nxtPct != null ? (nxtPct > 0 ? '▲' : nxtPct < 0 ? '▼' : '—') : '';
  const nxtPctStr = nxtPct != null ? `${nxtTriangle} ${Math.abs(nxtPct).toFixed(2)}%` : '';

  // 선택된 거래소 기준 주가 (손익 계산에 사용)
  const useNxt = isKR && state.domesticExchange === 'NXT' && nxtPrice;
  const currentPrice = useNxt ? nxtPrice : krxPrice;
  const pct = useNxt ? nxtPct : krxPct;

  const volume = q?.regularMarketVolume;
  const dayHigh = q?.regularMarketDayHigh || null;
  const dayLow  = q?.regularMarketDayLow  || null;

  let rangeBarHtml = '';
  if (dayHigh && dayLow && currentPrice && dayHigh > dayLow) {
    const pos = Math.max(0, Math.min(100, Math.round(((currentPrice - dayLow) / (dayHigh - dayLow)) * 100)));
    const fmtNum = (v) => currency === 'KRW' ? Math.round(v).toLocaleString('ko-KR') : v.toFixed(2);
    rangeBarHtml = `<div class="port-range-bar">
      <span class="port-range-low">${fmtNum(dayLow)}</span>
      <div class="port-range-track"><div class="port-range-fill" style="width:${pos}%"></div><div class="port-range-dot" style="left:${pos}%"></div></div>
      <span class="port-range-high">${fmtNum(dayHigh)}</span>
    </div>`;
  }

  const sparkData = state.sparklines[item.symbol];

  // 지지선: 하락 종목, 1년 데이터 기준
  const showSupport = pct < 0 && sparkData?.length >= 5 && currentPrice;
  let supportLevel = null;
  if (showSupport) {
    const closes = sparkData
      .slice(0, -1)
      .filter(v => v != null && !isNaN(v) && v > 0);
    const hist = closes.slice(0, closes.length - 5); // 최근 5거래일 노이즈 제외

    // 현재가 기준 15% 이내만 유효 (너무 먼 지지선은 무의미)
    const maxGap = currentPrice * 0.15;

    // 1. swing low 탐색: 좌우 3봉보다 낮고 현재가 이하 15% 이내
    const wing = 3;
    let swingLow = null;
    for (let i = hist.length - 1; i >= wing; i--) {
      const gap = currentPrice - hist[i];
      if (gap <= 0 || gap > maxGap) continue;
      const leftOK  = hist.slice(i - wing, i).every(v => v >= hist[i]);
      const rightOK = hist.slice(i + 1, Math.min(hist.length, i + wing + 1)).every(v => v >= hist[i]);
      if (leftOK && rightOK) { swingLow = hist[i]; break; }
    }

    // 2. MA 지지선 후보 (60/120/200일) — 현재가 이하 15% 이내만
    const maVal = (period) => {
      if (hist.length < period) return null;
      const v = hist.slice(-period).reduce((a, b) => a + b, 0) / period;
      const gap = currentPrice - v;
      return gap > 0 && gap <= maxGap ? v : null;
    };
    const maCandidates = [60, 120, 200].map(maVal).filter(v => v !== null);

    // 3. swing low + MA 후보 중 현재가에 가장 가까운(높은) 값을 지지선으로
    const allCandidates = [...(swingLow !== null ? [swingLow] : []), ...maCandidates];
    supportLevel = allCandidates.length > 0 ? Math.max(...allCandidates) : null;
  }

  // 장기 이평선 기울기 → 지지 배지 색상·아이콘 결정
  let maIconClass = '', maTrendClass = 'trend-none';
  if (showSupport && sparkData && sparkData.length >= 70) {
    const n = sparkData.length;
    const maAvg = (period, offset = 0) => {
      const sl = sparkData.slice(-(period + offset), offset > 0 ? -offset : undefined);
      return sl.length >= period ? sl.reduce((a, b) => a + b, 0) / sl.length : null;
    };
    const maDir = (period) => {
      const cur = maAvg(period), prev = maAvg(period, 10);
      return (cur !== null && prev !== null) ? (cur > prev ? 1 : cur < prev ? -1 : 0) : 0;
    };
    const dirs = [maDir(60), n >= 130 ? maDir(120) : null, n >= 210 ? maDir(200) : null].filter(v => v !== null);
    const allDown = dirs.every(d => d < 0), allUp = dirs.every(d => d > 0);
    if (allDown)    { maIconClass = 'ph ph-trend-down'; maTrendClass = 'trend-bear'; }
    else if (allUp) { maIconClass = 'ph ph-trend-up';   maTrendClass = 'trend-bull'; }
    else            { maIconClass = 'ph ph-minus';       maTrendClass = 'trend-mixed'; }
  }

  const supportInline = showSupport && supportLevel !== null
    ? `<span class="port-support-badge ${maTrendClass}">지지선 <span class="port-support-amt">${formatPrice(Math.round(supportLevel), currency)}</span>${maIconClass ? `<i class="${maIconClass}"></i>` : ''}</span>`
    : '';

  // RSI 상승 다이버전스 감지 (지지선 있을 때만)
  let divergenceBadge = '';
  if (showSupport && supportLevel !== null && sparkData && sparkData.length >= 30) {
    const validCloses = sparkData.filter(v => v != null && !isNaN(v) && v > 0);
    const rsi = calcRSI(validCloses);
    if (detectBullishDivergence(validCloses, rsi)) {
      divergenceBadge = `<span class="port-div-badge"><i class="ph ph-arrows-merge"></i> 반전신호</span>`;
    }
  }

  // miniSpark는 최근 22봉(1달)만 사용
  const sparkRecent = sparkData ? sparkData.slice(-22) : null;
  const miniSpark = sparkRecent
    ? `<div class="mini-sparkline-box">${buildSparklineSvg(sparkRecent, 10, false, true)}</div>` : '';

  const currentVal = currentPrice ? currentPrice * item.qty : null;
  const gain = currentVal !== null ? currentVal - invested : null;
  const gainPct = gain !== null && invested > 0 ? (gain / invested) * 100 : null;
  const gainClass = gain !== null ? (gain >= 0 ? 'gain-up' : 'gain-down') : '';
  const gainSign = gain !== null && gain >= 0 ? '+' : '';

  const fxRate = currency !== 'KRW' ? (state.fxRates[currency] || null) : null;
  const currentValKrw = fxRate && currentVal !== null ? currentVal * fxRate : null;
  const gainKrw = fxRate && gain !== null ? gain * fxRate : null;
  const krwRow = currentValKrw !== null ? `
      <div class="port-stat-krw">
        <span class="port-stat-krw-label">원화 환산</span>
        <span class="port-stat-krw-val">${formatPrice(currentValKrw, 'KRW')}<span class="${gainKrw !== null ? (gainKrw >= 0 ? 'gain-up' : 'gain-down') : ''}"> (${gainKrw !== null ? (gainKrw >= 0 ? '+' : '') + formatPrice(Math.abs(gainKrw), 'KRW') : '—'})</span></span>
      </div>` : '';

  const isExpanded = state.expandedPortfolioCards.has(item.symbol);
  const gainStr = gain !== null ? `${gainSign}${formatPrice(Math.abs(gain), currency)}` : '—';
  const pctStr = gainPct !== null ? `${gainSign}${gainPct.toFixed(2)}%` : '—';

  const changeClass = getChangeClass(pct);
  const dirClass = changeClass === 'up' ? 'dir-up' : changeClass === 'down' ? 'dir-down' : 'dir-flat';

  // KRX 표시용 변수
  const krxChangeClass = getChangeClass(krxPct);
  const krxTriangle = krxPct != null ? (krxPct > 0 ? '▲' : krxPct < 0 ? '▼' : '—') : '';
  const krxAbsPctStr = krxPct != null ? `${krxTriangle} ${Math.abs(krxPct).toFixed(2)}%` : '';

  // 등락금액
  const krxChange = isPost ? q?.postMarketChange : isPre ? q?.preMarketChange : q?.regularMarketChange ?? null;
  const nxtChange = q?.nxtChange ?? null;
  const fmtChange = (chg, cur) => chg != null ? `${chg >= 0 ? '+' : ''}${formatPrice(Math.abs(chg), cur)}` : '';

  const volNum = volume ? volume.toLocaleString('ko-KR') : '';

  // 정규장 row — only during pre/post market, shown in LEFT info column
  let regularLineLeft = '';
  if ((isPost || isPre) && q?.regularMarketPrice) {
    const regPct = q.regularMarketChangePercent;
    const regSign = regPct != null ? (regPct >= 0 ? '+' : '') : '';
    const regPctStr = regPct != null ? `(${regSign}${regPct.toFixed(2)}%)` : '';
    regularLineLeft = `
      <div class="port-regular-row">
        <span class="mts-regular-label">정규장</span>
        <span class="port-regular-price">${formatPrice(q.regularMarketPrice, currency)}</span>
        <span class="port-regular-chg ${getChangeClass(regPct)}">${regPctStr}</span>
      </div>`;
  }

  const showKrx = !isKR || state.domesticExchange !== 'NXT';
  const showNxt = isKR && state.domesticExchange === 'NXT' && nxtPrice;

  const cardClass = ['stock-card', dirClass, isExpanded ? 'expanded' : ''].filter(Boolean).join(' ');

  return `
  <div class="${cardClass}" data-symbol="${item.symbol}" data-portfolio="1" onclick="handlePortfolioItemClick('${item.symbol}')">
    <div class="stock-card-main">
      <div class="port-row">
        <div class="port-info">
          <div class="port-name">${item.name || q?.korName || item.symbol}</div>
          <div class="port-qty-row">${gain !== null ? `<span class="port-gain-side ${gainClass}">${gainSign}${formatPrice(Math.abs(gain), currency)}${gainPct !== null ? `<span class="port-gain-pct-inline"> (${gainSign}${gainPct.toFixed(2)}%)</span>` : ''}</span>` : ''}${miniSpark}${volNum ? `<span class="port-vol-group"><span class="port-vol-sep"> · </span><span class="port-vol-left">${volNum}</span></span>` : ''}${!isKR ? `<span class="port-vol-sep"> · </span><span class="port-ticker">${item.symbol}</span>` : ''}</div>
          ${regularLineLeft}
          ${rangeBarHtml}
        </div>
        <div class="port-price-col">
          ${showKrx ? `
          <div class="port-line1">
            <span class="port-price ${krxChangeClass}">${krxPrice ? formatPrice(krxPrice, currency) : '—'}</span>
          </div>
          <div class="port-line2">
            ${fmtChange(krxChange, currency) ? `<span class="port-diff ${krxChangeClass}">${fmtChange(krxChange, currency)}</span>` : ''}
            <span class="port-tri-pct ${krxChangeClass}">${krxAbsPctStr}</span>
          </div>
          ${(divergenceBadge || supportInline) ? `<div class="port-line3">${divergenceBadge}${supportInline}</div>` : ''}` : ''}
          ${showNxt ? `
          <div class="port-line1 nxt-line">
            <span class="port-price ${nxtChangeClass}">${formatPrice(nxtPrice, currency)}</span>
          </div>
          <div class="port-line2 nxt-line">
            ${fmtChange(nxtChange, currency) ? `<span class="port-diff ${nxtChangeClass}">${fmtChange(nxtChange, currency)}</span>` : ''}
            <span class="port-tri-pct ${nxtChangeClass}">${nxtPctStr}</span>
          </div>
          ${(divergenceBadge || supportInline) ? `<div class="port-line3">${divergenceBadge}${supportInline}</div>` : ''}` : ''}
        </div>
        <button class="port-dots-btn" onclick="event.stopPropagation();handlePortfolioCardTap('${item.symbol}')"><i class="ph ph-dots-three-vertical"></i></button>
      </div>
      <div class="port-expand-body">
        <div class="port-gain-summary">
          <span class="port-gain-label">손익</span>
          <span class="port-gain-val ${gainClass}">${gainStr}</span>
          <span class="port-gain-pct ${gainClass}">${pctStr}</span>
          <span class="port-gain-qty">${item.qty.toLocaleString('ko-KR')}주</span>
        </div>
        <div class="port-stats">
          <div class="port-stat">
            <span class="port-stat-label">매수가</span>
            <span class="port-stat-value">${formatPrice(item.buyPrice, currency)}</span>
          </div>
          <div class="port-stat">
            <span class="port-stat-label">투자금액</span>
            <span class="port-stat-value">${formatPrice(invested, currency)}</span>
          </div>
          <div class="port-stat">
            <span class="port-stat-label">평가금액</span>
            <span class="port-stat-value">${currentVal !== null ? formatPrice(currentVal, currency) : '—'}</span>
          </div>
          <div class="port-stat ${gainClass}">
            <span class="port-stat-label">수익률</span>
            <span class="port-stat-value">${gainPct !== null ? `${gainSign}${gainPct.toFixed(2)}%` : '—'}</span>
          </div>
          <div class="port-stat">
            <span class="port-stat-label">증권사</span>
            <span class="port-stat-value">${item.broker || '—'}</span>
          </div>
        </div>
        ${krwRow}
      </div>
    </div>
    <div class="card-actions">
      <button class="card-btn edit" onclick="openPortfolioEditModal(event,'${item.symbol}')"><i class="ph ph-pencil-simple"></i></button>
      <button class="card-btn del" onclick="confirmDeletePortfolio(event,'${item.symbol}')"><i class="ph ph-trash"></i></button>
    </div>
  </div>`;
}

function handlePortfolioCardTap(symbol) {
  if (isSwiping) return;
  const card = document.querySelector(`.stock-card[data-symbol="${symbol}"][data-portfolio="1"]`);
  if (!card) return;
  if (card.classList.contains('swiped')) {
    card.classList.remove('swiped');
    if (currentSwipedCard === card) currentSwipedCard = null;
    return;
  }
  if (isLandscape()) {
    renderDetailPanel(symbol);
  } else {
    const expanded = card.classList.toggle('expanded');
    if (expanded) state.expandedPortfolioCards.add(symbol);
    else state.expandedPortfolioCards.delete(symbol);
  }
}

function handlePortfolioItemClick(symbol) {
  if (isSwiping) return;
  const card = document.querySelector(`.stock-card[data-symbol="${symbol}"][data-portfolio="1"]`);
  if (!card) return;

  // 스와이프 열린 카드 닫기
  if (card.classList.contains('swiped')) {
    card.classList.remove('swiped');
    if (currentSwipedCard === card) currentSwipedCard = null;
    return;
  }

  if (isLandscape()) {
    renderDetailPanel(symbol);
  } else {
    const item = state.portfolio[symbol];
    const q = state.portfolioPrices[symbol];
    openChartModal(symbol, item?.name || q?.korName || symbol, null);
  }
}


function togglePortfolioSummary() {
  state.summaryExpanded = !state.summaryExpanded;
  renderPortfolioHoldings();
}

function toggleSummaryGroup(key) {
  state.summaryGroupExpanded[key] = !state.summaryGroupExpanded[key];
  const el = document.querySelector(`.psummary-group-detail[data-key="${key}"]`);
  if (el) { el.classList.toggle('expanded', state.summaryGroupExpanded[key]); return; }
  renderPortfolioHoldings();
}

// ── Landscape Detail Panel ─────────────────────────────────────────────────
function toTvSymbol(symbol) {
  if (/\.KS$/i.test(symbol)) return 'KRX:' + symbol.replace(/\.KS$/i, '');
  if (/\.KQ$/i.test(symbol)) return 'KOSDAQ:' + symbol.replace(/\.KQ$/i, '');
  return symbol.replace(/\.[A-Z]+$/i, '');
}

// tv.js는 최초 1회만 로드하고 이후 TradingView.widget() API를 직접 호출한다.
let _tvLibLoaded = false;
let _tvLibLoading = false;
const _tvLibQueue = [];

// "TradingView에서만 제공되는 심볼" 확인 다이얼로그 자동 닫기
// TV 위젯은 크로스 오리진 iframe을 사용하므로 세 가지 방어선을 동시 적용한다.
let _tvDialogObs = null;
function _setupTvDialogAutoDismiss() {
  // 1) window.confirm 오버라이드 — 일부 버전이 네이티브 confirm을 사용하는 경우
  if (!window._tvConfirmPatched) {
    window._tvConfirmPatched = true;
    const _orig = window.confirm;
    window.confirm = function(msg) {
      if (typeof msg === 'string' && /tradingview/i.test(msg)) return true;
      return _orig.apply(this, arguments);
    };
  }

  // 2) postMessage 수신 — TV iframe이 확인 요청을 postMessage로 중계하는 경우
  if (!window._tvMessagePatched) {
    window._tvMessagePatched = true;
    window.addEventListener('message', e => {
      if (typeof e.origin !== 'string' || !e.origin.includes('tradingview')) return;
      try { e.source?.postMessage({ name: 'widgetReady' }, '*'); } catch (_) {}
    });
  }

  // 3) MutationObserver — tv.js가 호스트 DOM에 다이얼로그 요소를 주입하는 경우
  if (_tvDialogObs) _tvDialogObs.disconnect();
  _tvDialogObs = new MutationObserver(() => {
    // TV가 주입하는 다이얼로그의 알려진 클래스 패턴
    const sel = [
      '.tv-dialog .tv-button--primary',
      '.tv-dialog__btn--primary',
      '[class*="acceptButton"]',
      '[class*="confirmButton"]',
    ].join(',');
    document.querySelectorAll(sel).forEach(btn => {
      if (btn.offsetParent !== null) btn.click();
    });
    // 버튼 텍스트가 "확인"/"OK"/"Got it"인 버튼을 tv-dialog 컨테이너 안에서 탐색
    document.querySelectorAll('.tv-dialog, [class*="tv-dialog"]').forEach(dlg => {
      const btn = [...dlg.querySelectorAll('button')].find(b => {
        const t = b.textContent.trim();
        return t === '확인' || t === 'OK' || t === 'Got it' || t === '알겠습니다';
      });
      if (btn && btn.offsetParent !== null) btn.click();
    });
  });
  _tvDialogObs.observe(document.body, { childList: true, subtree: true });
  // 10초 후 해제 (차트 로드가 완료된 이후에는 불필요)
  setTimeout(() => { _tvDialogObs?.disconnect(); _tvDialogObs = null; }, 10000);
}

function _loadTvLib(cb) {
  if (_tvLibLoaded) { cb(); return; }
  _tvLibQueue.push(cb);
  if (_tvLibLoading) return;
  _tvLibLoading = true;
  const s = document.createElement('script');
  s.src = 'https://s3.tradingview.com/tv.js';
  s.async = true;
  s.onload = () => {
    _tvLibLoaded = true;
    _tvLibLoading = false;
    _tvLibQueue.forEach(fn => fn());
    _tvLibQueue.length = 0;
  };
  s.onerror = () => { _tvLibLoading = false; _tvLibQueue.length = 0; };
  document.head.appendChild(s);
}

function _spawnTvWidget(tvSymbol, containerId, hideVolume) {
  const wrap = document.getElementById(containerId);
  if (!wrap) return;
  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  const widgetDivId = containerId + '-w';
  wrap.innerHTML = `<div id="${widgetDivId}" style="width:100%;height:100%"></div>`;
  _setupTvDialogAutoDismiss();
  _loadTvLib(() => {
    if (!document.getElementById(widgetDivId)) return;
    new TradingView.widget({
      autosize: true,
      symbol: tvSymbol,
      interval: 'D',
      timezone: 'Asia/Seoul',
      theme: isDark ? 'dark' : 'light',
      style: '1',
      locale: 'kr',
      hide_top_toolbar: false,
      hide_legend: true,
      allow_symbol_change: false,
      save_image: false,
      hide_volume: hideVolume,
      disabled_features: ['popup_hints'],
      container_id: widgetDivId,
    });
  });
}

function renderTvChart(symbol, containerId) {
  _spawnTvWidget(toTvSymbol(symbol), containerId, true);
}

// ── Lightweight Charts (국내 주식 전용) ────────────────────────────────────
let _lwcLoaded = false;
let _lwcLoading = false;
const _lwcQueue = [];

function _loadLwc(cb) {
  if (_lwcLoaded) { cb(); return; }
  _lwcQueue.push(cb);
  if (_lwcLoading) return;
  _lwcLoading = true;
  const s = document.createElement('script');
  s.src = 'https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js';
  s.async = true;
  s.onload = () => { _lwcLoaded = true; _lwcLoading = false; _lwcQueue.forEach(f => f()); _lwcQueue.length = 0; };
  s.onerror = () => { _lwcLoading = false; _lwcQueue.length = 0; };
  document.head.appendChild(s);
}

const KR_INTERVALS = [
  { key: '1m',  label: '1분',  defaultRange: '1d'  },
  { key: '1d',  label: '일봉', defaultRange: '3mo' },
];
const KR_DAY_RANGES = [
  { key: '1mo', label: '1개월' },
  { key: '3mo', label: '3개월' },
];

async function renderKrChart(yahooSymbol, containerId, interval = '1d', range) {
  if (!range) range = KR_INTERVALS.find(iv => iv.key === interval)?.defaultRange ?? '3mo';
  const wrap = document.getElementById(containerId);
  if (!wrap) return;

  const isIntraday = interval === '1m';

  const renderShell = (loadingMsg = '') => {
    const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
    const bg  = isDark ? '#1a1a1a' : '#fff';
    const col = isDark ? '#fff' : '#333';
    const act = isDark ? '#3a3a3a' : '#e0e0e0';
    wrap.innerHTML = `
      <div style="flex:1;display:flex;flex-direction:column;min-height:0;">
        <div style="display:flex;align-items:center;gap:6px;padding:8px 12px;background:${bg};border-bottom:1px solid ${isDark?'#2a2a2a':'#f0f0f0'}">
          <div style="display:flex;gap:4px;border-right:1px solid ${isDark?'#333':'#eee'};padding-right:6px">
            ${KR_INTERVALS.map(iv => `
              <button style="padding:4px 10px;border-radius:6px;border:none;cursor:pointer;font-size:12px;font-weight:600;
                             background:${iv.key===interval?act:'transparent'};color:${iv.key===interval?col:'var(--text-sub)'}"
                onclick="renderKrChart('${yahooSymbol}','${containerId}','${iv.key}')">
                ${iv.label}
              </button>`).join('')}
          </div>
          ${!isIntraday ? `
          <div style="display:flex;gap:4px;padding-left:2px">
            ${KR_DAY_RANGES.map(r => `
              <button style="padding:4px 10px;border-radius:6px;border:none;cursor:pointer;font-size:12px;font-weight:500;
                             background:${r.key===range?act:'transparent'};color:${r.key===range?col:'var(--text-sub)'}"
                onclick="renderKrChart('${yahooSymbol}','${containerId}','${interval}','${r.key}')">
                ${r.label}
              </button>`).join('')}
          </div>` : ''}
        </div>
        <div id="kr-chart-canvas" style="flex:1;position:relative;">
          ${loadingMsg ? `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--text-sub);font-size:14px">${loadingMsg}</div>` : ''}
        </div>
      </div>`;
  };

  renderShell('차트 로딩 중...');

  let candles;
  try {
    const data = await apiFetch(`/api/chart?symbol=${encodeURIComponent(yahooSymbol)}&interval=${interval}&range=${range}`);
    if (!data.candles?.length) throw new Error('no data');
    candles = data.candles;
  } catch {
    renderShell('차트 데이터를 불러올 수 없습니다');
    return;
  }

  renderShell();

  _loadLwc(() => requestAnimationFrame(() => {
    const canvas = document.getElementById('kr-chart-canvas');
    if (!canvas) return;
    const isDark = document.documentElement.getAttribute('data-theme') !== 'light';

    const chart = LightweightCharts.createChart(canvas, {
      width: canvas.clientWidth || canvas.offsetWidth || 300,
      height: canvas.clientHeight || canvas.offsetHeight || 300,
      layout: {
        background: { color: isDark ? '#1a1a1a' : '#ffffff' },
        textColor: isDark ? '#aaaaaa' : '#555555',
      },
      grid: {
        vertLines: { color: isDark ? '#2a2a2a' : '#f0f0f0' },
        horzLines: { color: isDark ? '#2a2a2a' : '#f0f0f0' },
      },
      rightPriceScale: { borderColor: isDark ? '#2a2a2a' : '#e0e0e0' },
      timeScale: {
        borderColor: isDark ? '#2a2a2a' : '#e0e0e0',
        timeVisible: isIntraday,
        secondsVisible: false,
      },
      localization: {
        priceFormatter: (p) => Math.round(p).toLocaleString(),
        timeFormatter: (t) => {
          if (typeof t !== 'number') return t;
          const d = new Date(t * 1000);
          return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
        },
      },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor:         '#f23645',
      downColor:       '#1a88ff',
      borderUpColor:   '#f23645',
      borderDownColor: '#1a88ff',
      wickUpColor:     '#f23645',
      wickDownColor:   '#1a88ff',
      priceFormat: {
        type: 'custom',
        formatter: (p) => Math.round(p).toLocaleString(),
      },
    });
    candleSeries.setData(candles);
    chart.timeScale().fitContent();

    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      chart.resize(width, height);
    });
    ro.observe(canvas);
  }));
}

function clearDetailPanel() {
  const detail = document.getElementById('ls-detail');
  if (!detail) return;
  detail.innerHTML = '<div class="ls-detail-empty"><i class="ph ph-chart-line-up"></i><span>종목을 선택하면<br>상세 정보가 표시됩니다</span></div>';
  document.querySelectorAll('#portfolio-holdings .stock-card').forEach(c => c.classList.remove('ls-selected'));
}

function renderDetailPanel(symbol) {
  const detail = document.getElementById('ls-detail');
  if (!detail) return;

  const item = state.portfolio[symbol];
  if (!item) { clearDetailPanel(); return; }

  // 국내 종목인데 수급 데이터 없으면 즉시 fetch 후 재렌더
  if (/\.(KS|KQ)$/i.test(symbol) && !state.supplyData[symbol]) {
    const code = symbol.replace(/\.(KS|KQ)$/i, '');
    apiFetch('/api/supply?code=' + code).then(data => {
      if (data && !data.error) {
        state.supplyData[symbol] = data;
        // 패널이 여전히 이 종목을 보여주고 있을 때만 재렌더
        const sel = document.querySelector('#portfolio-holdings .stock-card.ls-selected');
        if (sel && sel.dataset.symbol === symbol) renderDetailPanel(symbol);
      }
    }).catch(() => {});
  }

  const q = state.portfolioPrices[symbol];
  const currentPrice = getDisplayPrice(q);
  const pct = q ? (q.marketState === 'POST' && q.postMarketChangePercent ? q.postMarketChangePercent : q.marketState === 'PRE' && q.preMarketChangePercent ? q.preMarketChangePercent : q.regularMarketChangePercent) : null;
  const currency = q?.currency || item.currency || 'USD';
  const invested = (item.buyPrice || 0) * (item.qty || 0);
  const currentVal = currentPrice ? currentPrice * item.qty : null;
  const gain = currentVal !== null ? currentVal - invested : null;
  const gainPct = gain !== null && invested > 0 ? (gain / invested) * 100 : null;
  const gainClass = gain !== null ? (gain >= 0 ? 'gain-up' : 'gain-down') : '';
  const gainSign = gain !== null && gain >= 0 ? '+' : '';

  const fxRate = currency !== 'KRW' ? (state.fxRates[currency] || null) : null;
  const currentValKrw = fxRate && currentVal !== null ? currentVal * fxRate : null;
  const gainKrw = fxRate && gain !== null ? gain * fxRate : null;

  const krwBlock = currentValKrw !== null ? `
    <div class="ls-detail-krw">
      <div class="ls-detail-krw-label">원화 환산 (KRW)</div>
      <div class="ls-detail-krw-vals">
        <span>${formatPrice(currentValKrw, 'KRW')}</span>
        ${gainKrw !== null ? `<span class="${gainKrw >= 0 ? 'gain-up' : 'gain-down'}">${gainKrw >= 0 ? '+' : ''}${formatPrice(Math.abs(gainKrw), 'KRW')}</span>` : ''}
      </div>
    </div>` : '';

  const sd = /\.(KS|KQ)$/i.test(symbol) ? (state.supplyData[symbol] || null) : null;
  let supplyBlock = '';
  if (sd) {
    const fDir = sd.foreignDir, iDir = sd.institutionDir;
    const fUp = fDir === 'buy', iUp = iDir === 'buy';
    const fDown = fDir === 'sell', iDown = iDir === 'sell';
    const cls = (fUp && iUp) ? 'supply-bull' : (fDown && iDown) ? 'supply-bear' : 'supply-mixed';
    const fLabel = fUp ? '외↑' : fDown ? '외↓' : '외—';
    const iLabel = iUp ? '기↑' : iDown ? '기↓' : '기—';
    const fNet = typeof sd.foreignNet === 'number' ? sd.foreignNet.toLocaleString('ko-KR') : '—';
    const iNet = typeof sd.institutionNet === 'number' ? sd.institutionNet.toLocaleString('ko-KR') : '—';
    const fSign = fUp ? '+' : '';
    const iSign = iUp ? '+' : '';
    supplyBlock = `<div class="ls-detail-divider"></div>
    <div class="ls-supply-section">
      <div class="ls-supply-title">외인/기관 수급 <span class="ls-supply-days">(최근 ${sd.days || 5}거래일 누적)</span></div>
      <div class="ls-supply-row">
        <span class="port-supply-badge ${cls}">${fLabel}${iLabel}</span>
        <div class="ls-supply-vals">
          <div class="ls-supply-item ${fUp ? 'gain-up' : fDown ? 'gain-down' : ''}">
            <span class="ls-supply-label">외국인</span>
            <span class="ls-supply-val">${fSign}${fNet}주</span>
          </div>
          <div class="ls-supply-item ${iUp ? 'gain-up' : iDown ? 'gain-down' : ''}">
            <span class="ls-supply-label">기관</span>
            <span class="ls-supply-val">${iSign}${iNet}주</span>
          </div>
        </div>
      </div>
    </div>`;
  }

  const name = item.name || q?.korName || item.symbol;
  const inLandscape = window.matchMedia('(orientation: landscape)').matches;
  detail.innerHTML = `
  <div class="ls-detail-content">
    ${inLandscape ? `<div class="ls-detail-chart" id="ls-chart-wrap"></div>` : ''}
    <div class="ls-detail-header">
      <div>
        <div class="ls-detail-name">${name}</div>
        <div class="ls-detail-symbol">${item.symbol} · ${item.qty.toLocaleString('ko-KR')}주</div>
      </div>
      <div class="ls-detail-price-wrap">
        <div class="ls-detail-price">${currentPrice ? formatPrice(currentPrice, currency) : '—'}</div>
        <div class="stock-change ${getChangeClass(pct)}">${getChangeStr(pct)}</div>
      </div>
    </div>
    ${state.sparklines[symbol] && !inLandscape ? `<div class="ls-spark-wrap">${buildSparklineSvg(state.sparklines[symbol], 60, true)}</div>` : ''}
    <div class="ls-detail-divider"></div>
    <div class="ls-detail-stats">
      <div class="ls-detail-stat">
        <span class="ls-detail-stat-label">매수가</span>
        <span class="ls-detail-stat-value">${formatPrice(item.buyPrice, currency)}</span>
      </div>
      <div class="ls-detail-stat">
        <span class="ls-detail-stat-label">보유 수량</span>
        <span class="ls-detail-stat-value">${item.qty.toLocaleString('ko-KR')}주</span>
      </div>
      <div class="ls-detail-stat">
        <span class="ls-detail-stat-label">투자금액</span>
        <span class="ls-detail-stat-value">${formatPrice(invested, currency)}</span>
      </div>
      <div class="ls-detail-stat">
        <span class="ls-detail-stat-label">평가금액</span>
        <span class="ls-detail-stat-value">${currentVal !== null ? formatPrice(currentVal, currency) : '—'}</span>
      </div>
      <div class="ls-detail-stat ${gainClass}">
        <span class="ls-detail-stat-label">손익</span>
        <span class="ls-detail-stat-value">${gain !== null ? `${gainSign}${formatPrice(Math.abs(gain), currency)}` : '—'}</span>
      </div>
      <div class="ls-detail-stat ${gainClass}">
        <span class="ls-detail-stat-label">수익률</span>
        <span class="ls-detail-stat-value">${gainPct !== null ? `${gainSign}${gainPct.toFixed(2)}%` : '—'}</span>
      </div>
      <div class="ls-detail-stat">
        <span class="ls-detail-stat-label">증권사</span>
        <span class="ls-detail-stat-value">${item.broker || '—'}</span>
      </div>
    </div>
    ${krwBlock}
    ${supplyBlock}
    <div class="ls-detail-actions">
      <button class="btn-cancel" style="flex:1" onclick="openPortfolioEditModal(event,'${symbol}')">수정</button>
      <button class="ls-detail-del" onclick="confirmDeletePortfolio(event,'${symbol}')">삭제</button>
    </div>
  </div>`;

  if (inLandscape) {
    const isKospi  = /\.KS$/i.test(symbol);
    const isKosdaq = /\.KQ$/i.test(symbol);
    if (isKospi || isKosdaq) {
      renderKrChart(symbol, 'ls-chart-wrap');
    } else {
      renderTvChart(symbol, 'ls-chart-wrap');
    }
  }

  document.querySelectorAll('#portfolio-holdings .stock-card').forEach(c => c.classList.remove('ls-selected'));
  const card = document.querySelector(`.stock-card[data-symbol="${symbol}"][data-portfolio="1"]`);
  if (card) card.classList.add('ls-selected');
}

function openPortfolioEditModal(event, symbol) {
  event.stopPropagation();
  const item = state.portfolio[symbol];
  if (!item) return;
  openPortfolioModal(item.symbol, item.name, item.currency);
}

function renderPortfolioSearch() {
  const wrap = document.getElementById('home-search-results');
  if (!wrap) return;

  if (state.portfolioSearching) {
    wrap.innerHTML = [1, 2, 3].map(() => `<div class="skeleton" style="height:72px;border-radius:12px;margin-bottom:8px"></div>`).join('');
    return;
  }
  if (!state.portfolioSearchQ) { wrap.innerHTML = ''; return; }
  if (!state.portfolioSearchResults.length) {
    wrap.innerHTML = `<div class="search-hint"><div class="hint-icon"><i class="ph ph-smiley-blank"></i></div><div>검색 결과가 없습니다</div></div>`;
    return;
  }

  wrap.innerHTML = state.portfolioSearchResults.slice(0, 10).map(r => {
    const q = r.quote;
    const price = q?.regularMarketPrice;
    const pct = q?.regularMarketChangePercent;
    const currency = q?.currency || 'USD';
    const cls = getChangeClass(pct);
    const added = !!state.portfolio[r.symbol];
    const name = (r.longname || r.shortname || r.symbol).replace(/'/g, '');
    return `
    <div class="result-item ${added ? 'added' : ''}" onclick="openPortfolioModal('${r.symbol}','${name}','${currency}')">
      <div class="result-info">
        <div class="result-name">${r.longname || r.shortname || r.symbol}</div>
        <div class="result-meta"><span class="result-exchange">${r.exchange || ''}</span> <span>${r.symbol}</span></div>
      </div>
      <div class="result-right">
        <div class="result-price">${price ? formatPrice(price, currency) : (state.portfolioFetchingPrices ? '<span style="font-size:11px;color:var(--primary)">로딩중...</span>' : '—')}</div>
        <div class="result-change ${cls}">${getChangeStr(pct)}</div>
      </div>
      <button class="add-btn ${added ? 'added' : ''}" onclick="event.stopPropagation();openPortfolioModal('${r.symbol}','${name}','${currency}')">
        ${added ? '<i class="ph ph-check"></i>' : '<i class="ph ph-plus"></i>'}
      </button>
    </div>`;
  }).join('');
}

const SORT_MODES = ['gainPct', 'change', 'value', 'name'];
const SORT_LABELS = { gainPct: '수익률', change: '등락률', value: '평가금', name: '종목명' };
const SORT_ICONS  = { gainPct: 'ph-trend-up', change: 'ph-chart-bar', value: 'ph-currency-krw', name: 'ph-sort-ascending' };

function cycleSortMode(group) {
  const cur = state.portfolioSort[group];
  const next = SORT_MODES[(SORT_MODES.indexOf(cur) + 1) % SORT_MODES.length];
  state.portfolioSort[group] = next;
  localStorage.setItem('portfolioSort', JSON.stringify(state.portfolioSort));
  renderPortfolioHoldings();
}

function cycleDomesticExchange() {
  const modes = ['KRX', 'NXT'];
  const cur = state.domesticExchange === 'NXT' ? 'NXT' : 'KRX';
  const next = modes[(modes.indexOf(cur) + 1) % modes.length];
  state.domesticExchange = next;
  localStorage.setItem('domesticExchange', next);
  renderPortfolioHoldings();
}

function sortGroup(items, mode) {
  return [...items].sort((a, b) => {
    const qa = state.portfolioPrices[a.symbol];
    const qb = state.portfolioPrices[b.symbol];
    if (mode === 'name') {
      const na = qa?.korName || a.name || a.symbol;
      const nb = qb?.korName || b.name || b.symbol;
      return na.localeCompare(nb, 'ko');
    }
    if (mode === 'value') {
      const va = (qa?.regularMarketPrice || 0) * (a.qty || 0);
      const vb = (qb?.regularMarketPrice || 0) * (b.qty || 0);
      return vb - va;
    }
    if (mode === 'change') {
      return (getDisplayPct(qb) ?? -Infinity) - (getDisplayPct(qa) ?? -Infinity);
    }
    // gainPct (default)
    const pa = qa?.regularMarketPrice;
    const pb = qb?.regularMarketPrice;
    const ga = (pa && a.buyPrice && a.qty) ? (pa * a.qty - a.buyPrice * a.qty) / (a.buyPrice * a.qty) : -Infinity;
    const gb = (pb && b.buyPrice && b.qty) ? (pb * b.qty - b.buyPrice * b.qty) / (b.buyPrice * b.qty) : -Infinity;
    return gb - ga;
  });
}

function renderPortfolioHoldings() {
  const wrap = document.getElementById('portfolio-holdings');
  if (!wrap) return;
  const items = Object.values(state.portfolio);

  if (!items.length) {
    wrap.innerHTML = `
      <div class="empty">
        <div class="empty-icon"><i class="ph ph-wallet"></i></div>
        <div class="empty-title">보유 종목이 없습니다</div>
        <div class="empty-sub">상단 검색창에서 종목을 검색하여<br>내 주식을 추가하세요</div>
      </div>`;
    return;
  }

  const summary = renderPortfolioSummary();

  const getItemCurrency = item => state.portfolioPrices[item.symbol]?.currency || item.currency || 'USD';
  const domesticRaw = items.filter(item => getItemCurrency(item) === 'KRW');
  const foreignRaw  = items.filter(item => getItemCurrency(item) !== 'KRW');
  const domestic = sortGroup(domesticRaw, state.portfolioSort.domestic);
  const foreign  = sortGroup(foreignRaw,  state.portfolioSort.foreign);

  const upDownBadges = group => {
    const up   = group.filter(i => (getDisplayPct(state.portfolioPrices[i.symbol]) ?? 0) > 0).length;
    const down = group.filter(i => (getDisplayPct(state.portfolioPrices[i.symbol]) ?? 0) < 0).length;
    return `
      <span class="section-ud section-up ${up === 0 ? 'empty' : ''}"><i class="ph ph-trend-up"></i>${up}</span>
      <span class="section-ud section-down ${down === 0 ? 'empty' : ''}"><i class="ph ph-trend-down"></i>${down}</span>
    `;
  };

  const sortBtn = (group) => {
    const mode = state.portfolioSort[group];
    return `<button class="port-sort-btn" onclick="event.stopPropagation();cycleSortMode('${group}')">
      <i class="ph ${SORT_ICONS[mode]}"></i>
      <span>${SORT_LABELS[mode]}</span>
    </button>`;
  };

  const exchBtn = () => {
    const exch = state.domesticExchange === 'NXT' ? 'NXT' : 'KRX';
    return `<button class="port-exch-btn" onclick="event.stopPropagation();cycleDomesticExchange()">
      <span class="ex-badge ${exch.toLowerCase()}">${exch}</span>
    </button>`;
  };

  let html = summary;
  if (domestic.length) {
    const dcol = state.portfolioCollapsed.domestic;
    html += `<div class="portfolio-section-header" data-group="domestic" onclick="toggleGroupCollapse('domestic')">
      <span class="portfolio-section-flag">🇰🇷</span>
      <span class="portfolio-section-label">국내주식</span>
      <span class="section-ud-wrap">${upDownBadges(domestic)}</span>
      <span class="portfolio-section-count kr">${domestic.length}</span>
      ${sortBtn('domestic')}
      ${exchBtn()}
      <button class="port-dots-btn" onclick="event.stopPropagation();toggleGroupCollapse('domestic')">
        <i class="ph ph-dots-three-vertical"></i>
      </button>
    </div>
    <div class="port-group-cards${dcol ? ' collapsed' : ''}" data-group="domestic">
      ${domestic.map(item => renderPortfolioCard(item)).join('')}
    </div>`;
  }
  if (foreign.length) {
    const fcol = state.portfolioCollapsed.foreign;
    html += `<div class="portfolio-section-header" data-group="foreign" onclick="toggleGroupCollapse('foreign')">
      <span class="portfolio-section-flag">🇺🇸</span>
      <span class="portfolio-section-label">해외주식</span>
      <span class="section-ud-wrap">${upDownBadges(foreign)}</span>
      <span class="portfolio-section-count us">${foreign.length}</span>
      ${sortBtn('foreign')}
      <button class="port-dots-btn" onclick="event.stopPropagation();toggleGroupCollapse('foreign')">
        <i class="ph ph-dots-three-vertical"></i>
      </button>
    </div>
    <div class="port-group-cards${fcol ? ' collapsed' : ''}" data-group="foreign">
      ${foreign.map(item => renderPortfolioCard(item)).join('')}
    </div>`;
  }
  wrap.innerHTML = html;
}

function toggleGroupCollapse(group) {
  state.portfolioCollapsed[group] = !state.portfolioCollapsed[group];
  const collapsed = state.portfolioCollapsed[group];
  const cards = document.querySelector(`.port-group-cards[data-group="${group}"]`);
  const caret = document.querySelector(`.portfolio-section-header[data-group="${group}"] .port-group-caret`);
  if (cards) cards.classList.toggle('collapsed', collapsed);
  if (caret) caret.classList.toggle('collapsed', collapsed);
}


// ── Portfolio Search ───────────────────────────────────────────────────────
function setSearchBtnLoading(loading) {
  const icon = document.querySelector('#home-search-btn i');
  if (!icon) return;
  icon.className = loading ? 'ph ph-circle-notch spinning' : 'ph ph-magnifying-glass';
}

let portfolioSearchTimer;
async function doPortfolioSearch(q) {
  clearTimeout(portfolioSearchTimer);
  if (!q.trim()) { state.portfolioSearchResults = []; renderPortfolioSearch(); setSearchBtnLoading(false); return; }
  state.portfolioSearching = true;
  setSearchBtnLoading(true);
  renderPortfolioSearch();
  portfolioSearchTimer = setTimeout(async () => {
    try {
      const data = await apiFetch(`/api/search?q=${encodeURIComponent(q)}`);
      state.portfolioSearchResults = (data.quotes || []).filter(r => r.quoteType === 'EQUITY' || r.quoteType === 'ETF');
      state.portfolioSearching = false;
    } catch {
      state.portfolioSearchResults = [];
      state.portfolioSearching = false;
    }
    renderPortfolioSearch();

    if (state.portfolioSearchResults.length > 0) {
      state.portfolioFetchingPrices = true;
      try {
        const syms = state.portfolioSearchResults.slice(0, 10).map(r => encodeURIComponent(r.symbol)).join(',');
        const pd = await apiFetch(`/api/quote?symbols=${syms}`);
        const priceMap = {};
        (pd.quoteResponse?.result || []).forEach(p => { if (p.symbol) priceMap[p.symbol.toUpperCase()] = p; });
        state.portfolioSearchResults = state.portfolioSearchResults.map(r => ({ ...r, quote: priceMap[r.symbol.toUpperCase()] }));
      } catch {}
      state.portfolioFetchingPrices = false;
      renderPortfolioSearch();
    }
    setSearchBtnLoading(false);
  }, 400);
}

// ── Watchlist Inline Search ────────────────────────────────────────────────

function renderWatchlistSearch() {
  const wrap = document.getElementById('home-search-results');
  if (!wrap) return;
  if (state.watchlistSearching) {
    wrap.innerHTML = [1, 2, 3].map(() => `<div class="skeleton" style="height:72px;border-radius:12px;margin-bottom:8px"></div>`).join('');
    return;
  }
  if (!state.watchlistSearchQ) { wrap.innerHTML = ''; return; }
  if (!state.watchlistSearchResults.length) {
    wrap.innerHTML = `<div class="search-hint"><div class="hint-icon"><i class="ph ph-smiley-blank"></i></div><div>검색 결과가 없습니다</div></div>`;
    return;
  }
  wrap.innerHTML = state.watchlistSearchResults.slice(0, 10).map(r => {
    const q = r.quote;
    const price = q?.regularMarketPrice;
    const pct = q?.regularMarketChangePercent;
    const currency = q?.currency || 'USD';
    const cls = getChangeClass(pct);
    const added = !!state.watchlist[r.symbol];
    const name = (r.longname || r.shortname || r.symbol).replace(/'/g, '');
    return `
    <div class="result-item ${added ? 'added' : ''}" onclick="openAddModal('${r.symbol}','${name}','${currency}')">
      <div class="result-info">
        <div class="result-name">${r.longname || r.shortname || r.symbol}</div>
        <div class="result-meta"><span class="result-exchange">${r.exchange || ''}</span> <span>${r.symbol}</span></div>
      </div>
      <div class="result-right">
        <div class="result-price">${price ? formatPrice(price, currency) : (state.watchlistFetchingPrices ? '<span style="font-size:11px;color:var(--primary)">로딩중...</span>' : '—')}</div>
        <div class="result-change ${cls}">${getChangeStr(pct)}</div>
      </div>
      <button class="add-btn ${added ? 'added' : ''}" onclick="event.stopPropagation();openAddModal('${r.symbol}','${name}','${currency}')">
        ${added ? '<i class="ph ph-check"></i>' : '<i class="ph ph-plus"></i>'}
      </button>
    </div>`;
  }).join('');
}

let watchlistSearchTimer;
async function doWatchlistSearch(q) {
  clearTimeout(watchlistSearchTimer);
  if (!q.trim()) { state.watchlistSearchResults = []; renderWatchlistSearch(); setSearchBtnLoading(false); return; }
  state.watchlistSearching = true;
  setSearchBtnLoading(true);
  renderWatchlistSearch();
  watchlistSearchTimer = setTimeout(async () => {
    try {
      const data = await apiFetch(`/api/search?q=${encodeURIComponent(q)}`);
      state.watchlistSearchResults = (data.quotes || []).filter(r => r.quoteType === 'EQUITY' || r.quoteType === 'ETF');
      state.watchlistSearching = false;
    } catch {
      state.watchlistSearchResults = [];
      state.watchlistSearching = false;
    }
    renderWatchlistSearch();
    if (state.watchlistSearchResults.length > 0) {
      state.watchlistFetchingPrices = true;
      try {
        const syms = state.watchlistSearchResults.slice(0, 10).map(r => encodeURIComponent(r.symbol)).join(',');
        const pd = await apiFetch(`/api/quote?symbols=${syms}`);
        const priceMap = {};
        (pd.quoteResponse?.result || []).forEach(p => { if (p.symbol) priceMap[p.symbol.toUpperCase()] = p; });
        state.watchlistSearchResults = state.watchlistSearchResults.map(r => ({ ...r, quote: priceMap[r.symbol.toUpperCase()] }));
      } catch {}
      state.watchlistFetchingPrices = false;
      renderWatchlistSearch();
    }
    setSearchBtnLoading(false);
  }, 400);
}

// ── Portfolio Modal ────────────────────────────────────────────────────────
let portfolioModalData = {};

function openPortfolioModal(symbol, name, currency) {
  const existing = state.portfolio[symbol];
  portfolioModalData = { symbol, name, currency, existing };

  const q = state.portfolioPrices[symbol];
  const price = q?.regularMarketPrice;
  const cur = q?.currency || currency;

  document.getElementById('portfolio-modal-title').textContent = existing ? '내 주식 수정' : '내 주식 추가';
  document.getElementById('portfolio-modal-name').textContent = name;
  document.getElementById('portfolio-modal-symbol').textContent = symbol;
  document.getElementById('portfolio-modal-price').textContent = price ? formatPrice(price, cur) : '—';

  const buyInput = document.getElementById('portfolio-buy-price');
  const qtyInput = document.getElementById('portfolio-qty');
  const brokerSelect = document.getElementById('portfolio-broker');
  buyInput.value = existing?.buyPrice ? existing.buyPrice.toLocaleString('ko-KR', { maximumFractionDigits: 6 }) : '';
  qtyInput.value = existing?.qty ? existing.qty.toLocaleString('ko-KR', { maximumFractionDigits: 6 }) : '';
  if (!existing && price) buyInput.placeholder = formatPriceInputPlain(price, cur);
  if (brokerSelect) brokerSelect.value = existing?.broker || '';

  document.getElementById('portfolio-modal-overlay').classList.add('open');
}

function closePortfolioModal() {
  document.getElementById('portfolio-modal-overlay').classList.remove('open');
  setTimeout(() => { portfolioModalData = {}; }, 300);
}

async function savePortfolioModal() {
  const buyPrice = parseFloat(document.getElementById('portfolio-buy-price').value.replace(/,/g, '')) || null;
  const qty = parseFloat(document.getElementById('portfolio-qty').value.replace(/,/g, '')) || null;
  const broker = document.getElementById('portfolio-broker')?.value || '';
  const { symbol, name, currency, existing } = portfolioModalData;

  if (!buyPrice || !qty) { showToast('매수가와 수량을 입력해주세요'); return; }

  const q = state.portfolioPrices[symbol];
  const cur = q?.currency || currency;
  try {
    await savePortfolioItem(symbol, name, buyPrice, qty, cur, broker);
  } catch {
    showToast('저장 중 오류가 발생했습니다');
    return;
  }
  closePortfolioModal();
  await loadPortfolioPrices();
  renderPortfolioHoldings();
  renderPortfolioSearch();
  if (isLandscape()) renderDetailPanel(symbol);
  showToast(existing ? '✅ 수정되었습니다' : '✅ 추가되었습니다');
}

async function confirmDeletePortfolio(event, symbol) {
  event.stopPropagation();
  if (!confirm(`${state.portfolio[symbol]?.name || symbol} 종목을 삭제할까요?`)) return;
  try {
    await deletePortfolioItem(symbol);
    renderPortfolioHoldings();
    if (isLandscape()) clearDetailPanel();
    showToast('종목이 삭제되었습니다');
  } catch {
    showToast('삭제 중 오류가 발생했습니다');
  }
}

// ── Search bar sync ────────────────────────────────────────────────────────
function syncSearchBar(tab) {
  const input = document.getElementById('home-search-input');
  const clear = document.getElementById('home-search-clear');
  const resultsEl = document.getElementById('home-search-results');
  if (!input) return;
  input.value = '';
  clear?.classList.remove('visible');
  if (resultsEl) resultsEl.innerHTML = '';
  if (tab === 'portfolio') {
    input.placeholder = '종목 검색하여 추가';
    state.portfolioSearchQ = '';
    state.portfolioSearchResults = [];
  } else {
    input.placeholder = '종목 검색하여 추가';
    state.watchlistSearchQ = '';
    state.watchlistSearchResults = [];
  }
}

// ── News ───────────────────────────────────────────────────────────────────
async function loadNews() {
  const el = document.getElementById('news-list');
  if (!el) return;

  if (state.newsLoading) return;
  state.newsFilter = null;
  state.newsLoading = true;
  renderNews();

  try {
    const res = await fetch(`/api/news?clientId=${encodeURIComponent(state.clientId)}`);
    const data = await res.json();
    state.news = data.articles || [];
    state.newsLoaded = true;
  } catch (_) {
    state.news = [];
  } finally {
    state.newsLoading = false;
    renderNews();
  }
}

async function loadNewsForStock(symbol, name) {
  state.newsFilter = { symbol, name };
  state.newsLoading = true;
  state.newsLoaded = false;
  state.news = [];
  switchTab('news');
  const newsList = document.getElementById('news-list');
  if (newsList) newsList.scrollTop = 0;
  renderNews();

  try {
    const res = await fetch(`/api/news?symbol=${encodeURIComponent(symbol)}&name=${encodeURIComponent(name)}`);
    const data = await res.json();
    state.news = data.articles || [];
    state.newsLoaded = true;
  } catch (_) {
    state.news = [];
  } finally {
    state.newsLoading = false;
    renderNews();
  }
}

function clearNewsFilter() {
  state.newsFilter = null;
  state.newsLoaded = false;
  state.news = [];
  loadNews();
}

function renderNews() {
  const el = document.getElementById('news-list');
  if (!el) return;

  const filterBar = state.newsFilter
    ? `<div class="news-filter-bar">
        <i class="ph ph-funnel-simple"></i>
        <span class="news-filter-name">${state.newsFilter.name}</span>
        <span class="news-filter-label">뉴스</span>
        <button class="news-filter-clear" onclick="clearNewsFilter()">
          <i class="ph ph-x"></i> 전체보기
        </button>
      </div>`
    : '';

  if (state.newsLoading && !state.newsLoaded) {
    el.innerHTML = filterBar + '<div class="news-loading"><i class="ph ph-spinner news-spin"></i><span>뉴스를 불러오는 중...</span></div>';
    return;
  }

  if (!state.news.length) {
    el.innerHTML = filterBar + `<div class="news-empty"><i class="ph ph-newspaper"></i><span>${state.newsLoaded ? '관련 뉴스가 없습니다' : '보유종목을 추가하면 관련 뉴스를 볼 수 있습니다'}</span></div>`;
    return;
  }

  el.innerHTML = filterBar + state.news.map(a => {
    const ago = a.ts ? timeAgo(a.ts) : '';
    const src = a.source ? `<span class="news-source">${a.source}</span>` : '';
    return `<a class="news-card" href="${a.link || '#'}" target="_blank" rel="noopener">
      <div class="news-card-badge">${a.stockName}</div>
      <div class="news-card-title">${a.title}</div>
      <div class="news-card-meta">${src}${ago ? `<span class="news-card-time">${ago}</span>` : ''}</div>
    </a>`;
  }).join('');
}

// ── Market Trends ──────────────────────────────────────────────────────────
function isKrMarketOpen() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const day = kst.getUTCDay(); // 0=일, 6=토
  if (day === 0 || day === 6) return false;
  const mins = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  return mins >= 9 * 60 && mins < 15 * 60 + 30;
}

function computeSurgePicks() {
  const scanner = state.marketTop?.scanner || [];
  const spikes  = state.volumeSpikes?.kr   || [];

  const spikeMap = {};
  spikes.forEach(s => { spikeMap[s.symbol] = s; });

  return scanner
    .filter(s => s.pct > 0)
    .map(s => {
      const spike     = spikeMap[s.symbol];
      const pctScore  = Math.min(s.pct * 3, 30);
      const ratioScore = spike ? Math.min((spike.ratio / 100) * 10, 40) : 0;
      const str       = s.strength ?? 100;
      const strScore  = str > 100 ? Math.min((str - 100) / 6.67, 30) : 0;
      return { ...s, spike, score: Math.round(pctScore + ratioScore + strScore) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

function renderSurgePicks(picks) {
  const RANK = ['1', '2', '3'];
  const RANK_CLS = ['surge-rank-1', 'surge-rank-2', 'surge-rank-3'];
  return `
    <div class="surge-card">
      <div class="surge-header">
        <span class="surge-title"><i class="ph ph-rocket-launch"></i> 급등 가능 TOP 3</span>
        <span class="surge-live-badge">● 장중</span>
      </div>
      <div class="surge-desc">거래량 · 등락률 · 체결강도 종합 분석</div>
      <div class="surge-list">
        ${picks.map((s, i) => {
          const cls  = getChangeClass(s.pct);
          const sign = s.pct > 0 ? '+' : '';
          const barW = Math.min(s.score, 100);
          const ratioTxt = s.spike ? `거래 ${s.spike.ratio}%` : '';
          return `
            <div class="surge-item market-clickable"
                 data-code="${s.symbol}"
                 data-name="${(s.name || '').replace(/"/g, '&quot;')}"
                 data-market="${s.market}"
                 onclick="openChartModal(this.dataset.code, this.dataset.name, this.dataset.market)">
              <div class="surge-rank ${RANK_CLS[i]}">${RANK[i]}</div>
              <div class="surge-info">
                <div class="surge-name-row">
                  <span class="surge-name">${s.name}</span>
                  <span class="surge-mkt">${s.market === 'KOSPI' ? 'KOSPI' : 'KOSDAQ'}</span>
                </div>
                <div class="surge-bar-wrap"><div class="surge-bar" style="width:${barW}%"></div></div>
              </div>
              <div class="surge-right">
                <span class="surge-pct ${cls}">${sign}${s.pct.toFixed(2)}%</span>
                ${ratioTxt ? `<span class="surge-ratio">${ratioTxt}</span>` : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

async function loadMarketTrends() {
  if (state.marketLoading) return;
  state.marketLoading = true;
  document.getElementById('market-refresh-icon')?.classList.add('spinning');
  renderMarketTrends();

  try {
    const [m, t, v] = await Promise.all([
      apiFetch('/api/market'),
      apiFetch('/api/market-top'),
      apiFetch('/api/volume-spikes')
    ]);
    state.marketData = m;
    state.marketTop = t;
    state.volumeSpikes = v;
    state.marketLastUpdated = new Date();
  } catch (e) {
    console.error('Market load error:', e);
  } finally {
    state.marketLoading = false;
    document.getElementById('market-refresh-icon')?.classList.remove('spinning');
    renderMarketTrends();
  }
}

function renderMarketTrends() {
  const surgeEl  = document.getElementById('market-surge');
  const indicesEl = document.getElementById('market-indices');
  const topEl = document.getElementById('market-top-lists');
  const timeEl = document.getElementById('market-update-time');
  if (!indicesEl || !topEl) return;

  // Update time display
  if (timeEl) {
    if (state.marketLoading && !state.marketData) {
      timeEl.textContent = '불러오는 중...';
    } else if (state.marketLastUpdated) {
      const d = state.marketLastUpdated;
      const hh = d.getHours().toString().padStart(2, '0');
      const mm = d.getMinutes().toString().padStart(2, '0');
      timeEl.textContent = `${hh}:${mm} 업데이트`;
    }
  }

  if (state.marketLoading && !state.marketData) {
    indicesEl.innerHTML = '<div class="news-loading"><i class="ph ph-spinner news-spin"></i><span>증시 정보를 불러오는 중...</span></div>';
    topEl.innerHTML = '';
    if (surgeEl) surgeEl.innerHTML = '';
    return;
  }

  // Surge picks (장중 only)
  if (surgeEl) {
    const open = isKrMarketOpen();
    const picks = open ? computeSurgePicks() : [];
    surgeEl.innerHTML = picks.length ? renderSurgePicks(picks) : '';
  }

  // Indices
  if (state.marketData) {
    const d = state.marketData;
    const items = [
      { id: 'KOSPI',  data: d.kospi,  flag: '🇰🇷' },
      { id: 'KOSDAQ', data: d.kosdaq, flag: '🇰🇷' },
      { id: 'NASDAQ', data: d.nasdaq, flag: '🇺🇸' },
      { id: 'S&P 500',data: d.sp500,  flag: '🇺🇸' },
      { id: '환율',    data: d.usdkrw, flag: '💵' },
      { id: 'WTI',    data: d.wti,    flag: '🛢️' }
    ];

    indicesEl.innerHTML = `
      <div class="market-grid">
        ${items.filter(i => i.data).map(i => {
          const v = i.data;
          const pct = parseFloat(v.pct);
          const cls = getChangeClass(pct);
          const cardCls = pct > 0 ? 'up' : pct < 0 ? 'down' : '';
          const sign = pct > 0 ? '+' : '';
          return `
            <div class="market-idx-card ${cardCls}">
              <div class="midx-top">
                <span class="midx-flag">${i.flag}</span>
                <span class="midx-label">${i.id}</span>
              </div>
              <div class="midx-price">${v.price}</div>
              <div class="midx-change ${cls}">${sign}${v.diff} (${sign}${v.pct}%)</div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  // Top Volume
  if (state.marketTop) {
    const RANK_CLS = ['mtop-rank-1', 'mtop-rank-2', 'mtop-rank-3'];
    const buildList = (title, icon, list, isKr) => {
      if (!list?.length) return '';
      return `
        <div class="mtop-section">
          <div class="mtop-header"><i class="ph ${icon}"></i> ${title} 거래량 TOP 5</div>
          <div class="mtop-list">
            ${list.map((s, idx) => {
              const cls = getChangeClass(s.pct);
              const sign = s.pct > 0 ? '+' : '';
              const vol = isKr ? formatVolumeKr(s.volume) : formatVolume(s.volume);
              const badge = isKr && s.market ? `<span class="mtop-market-badge">${s.market}</span>` : `<span class="mtop-market-badge us">${s.symbol}</span>`;
              const rankCls = idx < 3 ? RANK_CLS[idx] : '';
              const mkt = isKr ? (s.market || 'KOSPI') : 'US';
              return `
                <div class="mtop-item market-clickable"
                     data-code="${s.symbol}"
                     data-name="${(s.name || '').replace(/"/g, '&quot;')}"
                     data-market="${mkt}"
                     onclick="openChartModal(this.dataset.code, this.dataset.name, this.dataset.market)">
                  <div class="mtop-rank ${rankCls}">${idx + 1}</div>
                  <div class="mtop-info">
                    <div class="mtop-name-row">
                      <span class="mtop-name">${s.name}</span>
                      ${badge}
                    </div>
                    <div class="mtop-vol">거래량 ${vol}</div>
                  </div>
                  <div class="mtop-right">
                    <div class="mtop-price">${isKr ? s.price : formatPrice(s.price, 'USD')}</div>
                    <div class="mtop-pct ${cls}">${sign}${s.pct.toFixed(2)}%</div>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    };

    const scannerHtml = state.marketTop.scanner?.length ? `
      <div class="mtop-section scanner-section">
        <div class="mtop-header"><i class="ph ph-fire-simple"></i> 거래량 상위 모멘텀</div>
        <div class="scanner-grid">
          ${state.marketTop.scanner.map(s => {
            const strCls = s.pct >= 0 ? 'gain-up' : 'gain-down';
            const sign = s.pct > 0 ? '+' : '';
            const vol = formatVolumeKr(s.volume);
            return `
              <div class="scanner-item market-clickable"
                   data-code="${s.symbol}"
                   data-name="${(s.name || '').replace(/"/g, '&quot;')}"
                   data-market="${s.market}"
                   onclick="openChartModal(this.dataset.code, this.dataset.name, this.dataset.market)">
                <div class="scanner-name-row">
                  <span class="scanner-name">${s.name}</span>
                  <span class="scanner-market">${s.market === 'KOSPI' ? 'KOSPI' : 'KOSDAQ'}</span>
                </div>
                <div class="scanner-data">
                  <span class="scanner-strength ${strCls}">${sign}${s.pct}%</span>
                  <span class="scanner-pct">${vol}</span>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    ` : '';

    topEl.innerHTML = `
      ${scannerHtml}
      ${buildList('국내주식', 'ph-chart-line-up', state.marketTop.kr, true)}
      ${buildList('해외주식', 'ph-globe', state.marketTop.us, false)}
    `;
  }

  // Volume Spikes
  if (state.volumeSpikes) {
    const spikeLabel = ratio => {
      if (ratio >= 300) return 'spike-fire';
      if (ratio >= 200) return 'spike-surge';
      return 'spike-up';
    };

    const buildSpikeList = (title, icon, list, isKr) => {
      if (!list?.length) return '';
      const RANK_CLS2 = ['mtop-rank-1', 'mtop-rank-2', 'mtop-rank-3'];
      return `
        <div class="mtop-section vspike-section">
          <div class="mtop-header">
            <i class="ph ${icon}"></i> ${title} 거래량 급증
            <span class="vspike-live">● LIVE</span>
          </div>
          <div class="vspike-desc">현재 거래량 ÷ 전일 동시간대 평균</div>
          <div class="mtop-list">
            ${list.map((s, idx) => {
              const cls = getChangeClass(s.pct);
              const sign = s.pct > 0 ? '+' : '';
              const lbl = spikeLabel(s.ratio);
              const rankCls = idx < 3 ? RANK_CLS2[idx] : '';
              const vol = isKr ? formatVolumeKr(s.curVol) : formatVolume(s.curVol);
              const avgVol = isKr ? formatVolumeKr(s.avgVol) : formatVolume(s.avgVol);
              const badge = isKr && s.market
                ? `<span class="mtop-market-badge">${s.market}</span>`
                : `<span class="mtop-market-badge us">${s.symbol}</span>`;
              const mkt2 = isKr ? (s.market || 'KOSPI') : 'US';
              return `
                <div class="mtop-item market-clickable"
                     data-code="${s.symbol}"
                     data-name="${(s.name || '').replace(/"/g, '&quot;')}"
                     data-market="${mkt2}"
                     onclick="openChartModal(this.dataset.code, this.dataset.name, this.dataset.market)">
                  <div class="mtop-rank ${rankCls}">${idx + 1}</div>
                  <div class="mtop-info">
                    <div class="mtop-name-row">
                      <span class="mtop-name">${s.name}</span>
                      ${badge}
                    </div>
                    <div class="mtop-vol">현재 ${vol} · 평균 ${avgVol}</div>
                  </div>
                  <div class="mtop-right">
                    <div class="vspike-ratio ${lbl}">${s.ratio}%</div>
                    <div class="mtop-pct ${cls}">${sign}${(s.pct ?? 0).toFixed(2)}%</div>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    };

    const spikeEl = document.createElement('div');
    spikeEl.innerHTML = `
      ${buildSpikeList('국내주식', 'ph-lightning', state.volumeSpikes.kr, true)}
      ${buildSpikeList('해외주식', 'ph-lightning', state.volumeSpikes.us, false)}
    `;
    topEl.appendChild(spikeEl);
  }
}

// ── Tabs ───────────────────────────────────────────────────────────────────
function switchTab(tab) {
  if (currentSwipedCard) { currentSwipedCard.classList.remove('swiped'); currentSwipedCard = null; }
  state.currentTab = tab;
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`screen-${tab}`)?.classList.add('active');
  const searchHeader = document.getElementById('search-header');
  if (searchHeader) searchHeader.classList.toggle('hidden', tab !== 'home' && tab !== 'portfolio');
  syncSearchBar(tab);
  // Highlight the matching bottom-nav tab (settings maps to 'more')
  const navTab = tab === 'settings' ? 'more' : tab;
  document.getElementById(`tab-${navTab}`)?.classList.add('active');

  if (tab === 'home') { renderHome(); renderWatchlistSearch(); }
  if (tab === 'more') updateProfileUI();
  if (tab === 'settings') renderSettings();
  if (tab === 'news') loadNews();
  if (tab === 'market') loadMarketTrends();
  if (tab === 'portfolio') {
    renderPortfolioHoldings();
    renderPortfolioSearch();
    if (Object.keys(state.portfolio).length) {
      Promise.all([loadPortfolioPrices(), fetchFxRates()]).then(() => {
        if (state.currentTab === 'portfolio') renderPortfolioHoldings();
      });
    } else {
      fetchFxRates();
    }
  }
}

// ── Theme ──────────────────────────────────────────────────────────────────
function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', state.theme);
  document.documentElement.setAttribute('data-theme', state.theme);
  renderSettings();
}

// ── Profile Personalization ────────────────────────────────────────────────
function updateProfileUI() {
  const el = document.getElementById('profile-name');
  if (el) el.textContent = `${state.userName} 님`;
}

function editUserName() {
  const newName = prompt('사용하실 이름을 입력해주세요:', state.userName);
  if (newName === null) return;
  const trimmed = newName.trim();
  if (!trimmed) { showToast('이름을 입력해주세요'); return; }
  if (trimmed.length > 10) { showToast('이름은 10자 이내로 입력해주세요'); return; }
  
  state.userName = trimmed;
  localStorage.setItem('userName', trimmed);
  updateProfileUI();
  showToast(`반갑습니다, ${trimmed} 님!`);
}

// ── Toast ──────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}

// ── Refresh ────────────────────────────────────────────────────────────────
async function refreshPrices() {
  await loadPrices();
  renderHome();
}

// ── Auto refresh ───────────────────────────────────────────────────────────
let autoRefreshTimer;
function startAutoRefresh() {
  clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(async () => {
    if (document.visibilityState !== 'visible') return;
    if (Object.keys(state.watchlist).length) {
      await loadPrices();
      if (state.currentTab === 'home') renderHome();
    }
    if (state.currentTab === 'portfolio' && Object.keys(state.portfolio).length) {
      await Promise.all([loadPortfolioPrices(), fetchFxRates()]);
      renderPortfolioHoldings();
    }
  }, 60000); // refresh every minute when visible
}

// ── PWA Install ────────────────────────────────────────────────────────────
async function installApp() {
  if (!state.installPrompt) return;
  state.installPrompt.prompt();
  const { outcome } = await state.installPrompt.userChoice;
  if (outcome === 'accepted') {
    state.installPrompt = null;
    renderBanners();
    showToast('앱이 설치되었습니다!');
  }
}

// ── Pull-to-Refresh (보유종목 화면) ────────────────────────────────────────
function setupPullToRefresh() {
  const main = document.querySelector('.main');
  const bar  = document.getElementById('ptr-bar');
  const icon = document.getElementById('ptr-icon');
  if (!main || !bar || !icon) return;

  const THRESHOLD = 64;
  let startY = 0;
  let startX = 0;
  let isPulling = false;
  let isRefreshing = false;

  main.addEventListener('touchstart', e => {
    if (state.currentTab !== 'portfolio' || isRefreshing) return;
    startY = e.touches[0].clientY;
    startX = e.touches[0].clientX;
    isPulling = false;
  }, { passive: true });

  main.addEventListener('touchmove', e => {
    if (state.currentTab !== 'portfolio' || isRefreshing) return;
    const dy = e.touches[0].clientY - startY;
    const dx = Math.abs(e.touches[0].clientX - startX);
    // 스크롤 상단에서 아래로, 수직 방향 제스처일 때만 활성화
    if (main.scrollTop > 2 || dy < 8 || dx > dy) return;
    isPulling = true;
    const ratio = Math.min(dy / THRESHOLD, 1);
    icon.style.transform = `rotate(${Math.round(ratio * 270)}deg)`;
    bar.classList.toggle('ptr-visible', dy >= THRESHOLD);
  }, { passive: true });

  main.addEventListener('touchend', async () => {
    if (!isPulling) return;
    isPulling = false;
    if (!bar.classList.contains('ptr-visible')) {
      icon.style.transform = '';
      return;
    }
    isRefreshing = true;
    bar.classList.add('ptr-refreshing');
    icon.style.transform = '';
    try {
      await Promise.all([loadPortfolioPrices(), fetchFxRates()]);
      fetchSupplyData().then(() => {
        if (state.currentTab === 'portfolio') renderPortfolioHoldings();
        const sel = document.querySelector('#portfolio-holdings .stock-card.ls-selected');
        if (sel) renderDetailPanel(sel.dataset.symbol);
      }).catch(() => {});
      if (state.currentTab === 'portfolio') renderPortfolioHoldings();
      showToast('최신 정보로 갱신되었습니다');
    } finally {
      bar.classList.remove('ptr-visible', 'ptr-refreshing');
      isRefreshing = false;
    }
  }, { passive: true });
}

// ── Event Listeners ────────────────────────────────────────────────────────
function setupEventListeners() {
  setupPullToRefresh();
  // Tab navigation
  ['portfolio', 'home', 'market', 'news', 'more'].forEach(tab => {
    const btn = document.getElementById(`tab-${tab}`);
    if (btn) btn.onclick = () => switchTab(tab);
  });

  // Unified header search — routes to watchlist or portfolio depending on active tab
  const homeSearchInput = document.getElementById('home-search-input');
  const homeSearchClear = document.getElementById('home-search-clear');
  homeSearchInput?.addEventListener('input', e => {
    const v = e.target.value;
    homeSearchClear?.classList.toggle('visible', !!v);
    if (state.currentTab === 'portfolio') {
      state.portfolioSearchQ = v;
      if (!v) { state.portfolioSearchResults = []; renderPortfolioSearch(); setSearchBtnLoading(false); return; }
      doPortfolioSearch(v);
    } else {
      state.watchlistSearchQ = v;
      if (!v) { state.watchlistSearchResults = []; renderWatchlistSearch(); setSearchBtnLoading(false); return; }
      doWatchlistSearch(v);
    }
  });
  homeSearchClear?.addEventListener('click', () => {
    if (homeSearchInput) homeSearchInput.value = '';
    homeSearchClear.classList.remove('visible');
    if (state.currentTab === 'portfolio') {
      state.portfolioSearchResults = [];
      state.portfolioSearchQ = '';
      setSearchBtnLoading(false);
      renderPortfolioSearch();
    } else {
      state.watchlistSearchResults = [];
      state.watchlistSearchQ = '';
      setSearchBtnLoading(false);
      renderWatchlistSearch();
    }
    homeSearchInput?.focus();
  });

  const triggerSearch = () => {
    const v = homeSearchInput?.value || '';
    if (!v.trim()) return;
    if (state.currentTab === 'portfolio') doPortfolioSearch(v);
    else doWatchlistSearch(v);
  };

  document.getElementById('home-search-btn')?.addEventListener('click', triggerSearch);
  homeSearchInput?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); triggerSearch(); } });

  // Chart modal ESC
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeChartModal(); });

  // Modal
  document.getElementById('modal-overlay')?.addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
  });
  document.getElementById('modal-cancel')?.addEventListener('click', closeModal);
  document.getElementById('modal-save')?.addEventListener('click', saveModal);

  // Profile
  document.getElementById('edit-name-btn')?.addEventListener('click', editUserName);


  // Portfolio modal
  document.getElementById('portfolio-modal-overlay')?.addEventListener('click', e => {
    if (e.target === document.getElementById('portfolio-modal-overlay')) closePortfolioModal();
  });
  document.getElementById('portfolio-modal-cancel')?.addEventListener('click', closePortfolioModal);
  document.getElementById('portfolio-modal-save')?.addEventListener('click', savePortfolioModal);

  const formatNumberInput = (e) => {
    let val = e.target.value.replace(/[^0-9.]/g, '');
    if (!val) { e.target.value = ''; return; }
    let parts = val.split('.');
    if (parts.length > 2) parts = [parts[0], parts.slice(1).join('')];
    if (parts[0]) parts[0] = parseInt(parts[0], 10).toLocaleString('ko-KR');
    e.target.value = parts.join('.');
  };
  document.getElementById('portfolio-buy-price')?.addEventListener('input', formatNumberInput);
  document.getElementById('portfolio-qty')?.addEventListener('input', formatNumberInput);

  // Refresh
  document.getElementById('market-refresh-btn')?.addEventListener('click', loadMarketTrends);

  // Notification banner
  document.getElementById('notif-enable-btn')?.addEventListener('click', requestPushPermission);
  const nClose = document.getElementById('notif-close-btn');
  if (nClose) {
    nClose.onclick = (e) => {
      e.preventDefault();
      state.notifBannerClosed = true;
      renderBanners();
    };
  }

  // Install banner
  document.getElementById('install-btn')?.addEventListener('click', () => {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    if (isIOS) {
      document.getElementById('ios-install-guide')?.classList.remove('hidden');
    } else {
      installApp();
    }
  });
  const iClose = document.getElementById('install-close-btn');
  if (iClose) {
    iClose.onclick = (e) => {
      e.preventDefault();
      state.installBannerClosed = true;
      renderBanners();
    };
  }

  // iOS guide close
  document.getElementById('ios-guide-close')?.addEventListener('click', () => {
    document.getElementById('ios-install-guide')?.classList.add('hidden');
  });
  document.getElementById('ios-install-guide')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      e.currentTarget.classList.add('hidden');
    }
  });

  // PWA install prompt (Android/Chrome)
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    state.installPrompt = e;
    renderBanners();
  });

  // Visibility change for refresh
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshPrices();
  });

  // Orientation change — re-render active screen to apply landscape/portrait logic
  window.addEventListener('orientationchange', () => {
    setTimeout(() => {
      // Close any open swipe-delete card when rotating to landscape
      if (currentSwipedCard) { currentSwipedCard.classList.remove('swiped'); currentSwipedCard = null; }
      if (state.currentTab === 'portfolio') {
        renderPortfolioHoldings();
        if (!isLandscape()) clearDetailPanel();
      }
      if (state.currentTab === 'home') renderHome();
    }, 300);
  });
}

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  try {
    document.documentElement.setAttribute('data-theme', state.theme);

    // Register SW
    if ('serviceWorker' in navigator) {
      try {
        state.swReg = await navigator.serviceWorker.register('/sw.js');
      } catch (e) {
        console.warn('SW registration failed:', e);
      }
    }

    await updateNotifStatus();
    renderBanners();
    setupEventListeners();
    checkBiometricLock();

    // 스파크라인 캐시 복원 (4시간 이내)
    try {
      const _sp = localStorage.getItem('sparklines_v3');
      if (_sp) {
        const { data, ts } = JSON.parse(_sp);
        if (Date.now() - ts < 4 * 60 * 60 * 1000) { state.sparklines = data || {}; state.sparklinesUpdatedAt = ts; }
      }
    } catch (_) {}

    // Load data
    state.loading = true;
    renderHome();
    await loadWatchlist();
    await loadPrices();
    await loadPortfolio();
    await loadPortfolioPrices();
    await fetchFxRates();
    await loadSparklines();
    fetchSupplyData().then(() => {
      renderPortfolioHoldings();
      const sel = document.querySelector('#portfolio-holdings .stock-card.ls-selected');
      if (sel) renderDetailPanel(sel.dataset.symbol);
    }).catch(() => {});
    state.loading = false;
    renderHome();

    switchTab('portfolio');
    setupSwipeEvents();
    startAutoRefresh();

    // Auto-subscribe if permission already granted
    if (Notification.permission === 'granted' && state.notifStatus !== 'active') {
      await subscribePush();
      await updateNotifStatus();
    }
  } catch (err) {
    console.error('Init error:', err);
    showToast('앱 초기화 중 오류가 발생했습니다');
  }
}

document.addEventListener('DOMContentLoaded', init);
