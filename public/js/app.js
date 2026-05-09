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
  return `${Math.floor(sec / 3600)}시간 전`;
}

function isLandscape() {
  return window.matchMedia('(orientation: landscape)').matches;
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
  watchlistSearchResults: [],
  watchlistSearchQ: '',
  watchlistSearching: false,
  watchlistFetchingPrices: false,
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
    const cached = localStorage.getItem('watchlist');
    if (cached) state.watchlist = JSON.parse(cached);
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
    const cached = localStorage.getItem('portfolio');
    if (cached) state.portfolio = JSON.parse(cached);
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
    localStorage.setItem('portfolioPrices', JSON.stringify(state.portfolioPrices));
  } catch {
    const cached = localStorage.getItem('portfolioPrices');
    if (cached) state.portfolioPrices = JSON.parse(cached);
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

async function savePortfolioItem(symbol, name, buyPrice, qty, currency) {
  const item = { symbol, name, buyPrice, qty, currency };
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

function stockLogoHtml(symbol, name) {
  const base = symbol.replace(/\.(KS|KQ)$/, '');
  const url = `https://financialmodelingprep.com/image-stock/${base}.png`;
  const letter = (name || symbol).charAt(0).toUpperCase();
  const palette = ['#3B82F6','#8B5CF6','#10B981','#F59E0B','#EF4444','#6366F1','#EC4899','#14B8A6','#F97316'];
  const color = palette[base.charCodeAt(0) % palette.length];
  return `<div class="stock-logo"><img src="${url}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" onload="this.nextElementSibling.style.display='none'"><div class="stock-logo-fallback" style="background:${color}">${letter}</div></div>`;
}

let searchTimer;
async function doSearch(q) {
  clearTimeout(searchTimer);
  if (!q.trim()) { state.searchResults = []; renderSearchResults(); return; }
  state.searching = true;
  renderSearchResults();
  searchTimer = setTimeout(async () => {
    // 1단계: 종목 검색 결과 즉시 표시
    try {
      const data = await apiFetch(`/api/search?q=${encodeURIComponent(q)}`);
      state.searchResults = (data.quotes || []).filter(r => r.quoteType === 'EQUITY' || r.quoteType === 'ETF');
      state.searching = false;
      renderSearchResults(); 
    } catch (e) {
      console.warn('Search failed:', e);
      state.searchResults = [];
      state.searching = false;
      renderSearchResults();
      return;
    }

    // 2단계: 주가 정보 추가 조회
    if (state.searchResults.length > 0) {
      state.fetchingPrices = true;
      try {
        const syms = state.searchResults.slice(0, 10).map(r => encodeURIComponent(r.symbol)).join(',');
        const pd = await apiFetch(`/api/quote?symbols=${syms}`);
        const priceMap = {};
        (pd.quoteResponse?.result || []).forEach(p => {
          if (p.symbol) priceMap[p.symbol.toUpperCase()] = p;
        });
        state.searchResults = state.searchResults.map(r => ({
          ...r,
          quote: priceMap[r.symbol.toUpperCase()]
        }));
      } catch (e) { console.warn('Search price fetch failed:', e); }
      state.fetchingPrices = false;
    }
    state.searching = false;
    renderSearchResults();
  }, 400);
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

  // Install banner
  if (state.installPrompt && !state.installBannerClosed) {
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
        ${stockLogoHtml(item.symbol, q?.korName || item.name)}
        <div class="mts-info">
          <div class="mts-name-row">
            <span class="stock-name">${q?.korName || item.name || item.symbol}</span>
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

function renderSearchResults() {
  const wrap = document.getElementById('search-results');
  if (state.searching) {
    wrap.innerHTML = [1, 2, 3].map(() => `<div class="skeleton" style="height:72px;border-radius:12px;margin-bottom:8px"></div>`).join('');
    return;
  }
  const q = document.getElementById('search-input')?.value;
  if (!q?.trim()) {
    wrap.innerHTML = `
      <div class="search-hint">
        <div class="hint-icon"><i class="ph ph-magnifying-glass"></i></div>
        <div>종목명 또는 티커를 입력하세요<br>
        <span style="font-size:12px;color:var(--text-sub)">예: 삼성전자, AAPL, 카카오, TSLA</span></div>
      </div>`;
    return;
  }
  if (!state.searchResults.length) {
    wrap.innerHTML = `<div class="search-hint"><div class="hint-icon"><i class="ph ph-smiley-blank"></i></div><div>검색 결과가 없습니다</div></div>`;
    return;
  }

  wrap.innerHTML = state.searchResults.slice(0, 10).map(r => {
    const q = r.quote;
    const price = q?.regularMarketPrice;
    const pct = q?.regularMarketChangePercent;
    const currency = q?.currency || 'USD';
    const cls = getChangeClass(pct);
    const added = !!state.watchlist[r.symbol];
    return `
    <div class="result-item ${added ? 'added' : ''}" onclick="openAddModal('${r.symbol}','${(r.longname || r.shortname || r.symbol).replace(/'/g, '')}','${currency}')">
      ${stockLogoHtml(r.symbol, r.shortname || r.longname)}
      <div class="result-info">
        <div class="result-name">${r.longname || r.shortname || r.symbol}</div>
        <div class="result-meta">
          <span class="result-exchange">${r.exchange || ''}</span>
          <span>${r.symbol}</span>
        </div>
      </div>
      <div class="result-right">
        <div class="result-price">${price ? formatPrice(price, currency) : (state.fetchingPrices ? '<span style="font-size:11px;color:var(--primary);font-weight:500">가격 로딩 중...</span>' : '—')}</div>
        <div class="result-change ${cls}">${getChangeStr(pct)}</div>
      </div>
      <button class="add-btn ${added ? 'added' : ''}" onclick="event.stopPropagation();openAddModal('${r.symbol}','${(r.longname || r.shortname || r.symbol).replace(/'/g, '')}','${currency}')">
        ${added ? '<i class="ph ph-check"></i>' : '<i class="ph ph-plus"></i>'}
      </button>
    </div>`;
  }).join('');
}

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
        <div class="info-row-label"><i class="ph ph-info info-row-icon"></i>NATO</div>
        <div class="info-row-value">v1.1.0</div>
      </div>
      <div class="info-row">
        <div class="info-row-label"><i class="ph ph-clock info-row-icon"></i>데이터 갱신</div>
        <div class="info-row-value">2분마다</div>
      </div>
      <div class="info-row">
        <div class="info-row-label"><i class="ph ph-stack info-row-icon"></i>관심 종목</div>
        <div class="info-row-value">${Object.keys(state.watchlist).length}개</div>
      </div>
    </div>
    <div class="section-title">iOS 안내</div>
    <div class="info-card">
      <div class="info-row" style="flex-direction:column;align-items:flex-start;gap:8px">
        <div class="info-row-label"><i class="ph ph-device-mobile info-row-icon"></i>홈 화면 추가 방법</div>
        <div style="font-size:12px;color:var(--text-sub);line-height:1.6">
          Safari → 공유 버튼(<i class="ph ph-export"></i>) → <strong style="color:var(--text)">홈 화면에 추가</strong> 를 탭하세요.<br>
          iOS 16.4 이상에서 푸시 알림이 지원됩니다.
        </div>
      </div>
    </div>`;
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
  if (isSwiping) {
    console.log('Tap ignored due to swipe');
    return;
  }
  
  const card = document.querySelector(`.stock-card[data-symbol="${symbol}"]`);
  if (!card) return;
  
  if (card.classList.contains('swiped')) {
    card.classList.remove('swiped');
    if (currentSwipedCard === card) currentSwipedCard = null;
  }
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
    const dx = swipeStart.x - e.clientX;
    const dy = Math.abs(swipeStart.y - e.clientY);
    if (dx > 30 && dy < 80) revealActions(card);
    else if (dx < -20 && card.classList.contains('swiped')) hideActions(card);
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
function renderPortfolioSummary() {
  const items = Object.values(state.portfolio);
  if (!items.length) return '';

  // 국내(KRW) / 해외(non-KRW) 분리 집계
  const krw = { invested: 0, current: 0, hasPrices: false, count: 0 };
  const foreign = { investedKrw: 0, currentKrw: 0, hasPrices: false, count: 0, byCurrency: {} };

  for (const item of items) {
    const q = state.portfolioPrices[item.symbol];
    const currency = q?.currency || item.currency || 'USD';
    const price = q?.regularMarketPrice;
    const invested = (item.buyPrice || 0) * (item.qty || 0);
    const current = price ? price * item.qty : null;

    if (currency === 'KRW') {
      krw.count++;
      krw.invested += invested;
      if (current !== null) { krw.current += current; krw.hasPrices = true; }
    } else {
      foreign.count++;
      if (!foreign.byCurrency[currency]) foreign.byCurrency[currency] = { invested: 0, current: 0, hasPrices: false };
      foreign.byCurrency[currency].invested += invested;
      const rate = state.fxRates[currency] || null;
      if (rate) foreign.investedKrw += invested * rate;
      if (current !== null) {
        foreign.byCurrency[currency].current += current;
        foreign.byCurrency[currency].hasPrices = true;
        if (rate) { foreign.currentKrw += current * rate; foreign.hasPrices = true; }
      }
    }
  }

  const summaryGroupRow = (key, flag, label, totalStr, pctStr, gc, detailHtml) => {
    const isExp = !!(state.summaryGroupExpanded && state.summaryGroupExpanded[key]);
    return `
    <div class="psummary-group-row">
      <div class="psummary-flag">${flag}</div>
      <div class="psummary-group-info">
        <div class="psummary-group-label">${label}</div>
        <div class="psummary-group-val">
          <span class="psummary-group-total">${totalStr}</span>
          <span class="psummary-group-pct ${gc}">${pctStr}</span>
        </div>
      </div>
      <button class="port-dots-btn" onclick="event.stopPropagation();toggleSummaryGroup('${key}')"><i class="ph ph-dots-three-vertical"></i></button>
    </div>
    <div class="psummary-group-detail${isExp ? ' expanded' : ''}" data-key="${key}">${detailHtml}</div>`;
  };

  const statsGrid = (rows) => `<div class="psummary-stats">${rows.map(([label, val, cls]) =>
    `<div class="psummary-stat"><span class="psummary-stat-label">${label}</span><span class="psummary-stat-val${cls ? ' ' + cls : ''}">${val}</span></div>`
  ).join('')}</div>`;

  let html = '<div class="portfolio-summary">';

  // 국내주식
  if (krw.count > 0) {
    const gain = krw.hasPrices ? krw.current - krw.invested : null;
    const gainPct = gain !== null && krw.invested > 0 ? (gain / krw.invested) * 100 : null;
    const gc = gain !== null ? (gain >= 0 ? 'gain-up' : 'gain-down') : '';
    const gs = gain !== null && gain >= 0 ? '+' : '';
    const totalStr = krw.hasPrices ? formatPrice(krw.current, 'KRW') : '—';
    const pctStr = gainPct !== null ? `${gs}${gainPct.toFixed(1)}%` : '—';
    const detail = statsGrid([
      ['투자금액', formatPrice(krw.invested, 'KRW'), ''],
      ['평가금액', krw.hasPrices ? formatPrice(krw.current, 'KRW') : '—', ''],
      ['손익', gain !== null ? `${gs}${formatPrice(Math.abs(gain), 'KRW')}` : '—', gc],
      ['수익률', pctStr, gc],
    ]);
    html += summaryGroupRow('KRW', '🇰🇷', `국내주식 <span class="psummary-count">${krw.count}종목</span>`, totalStr, pctStr, gc, detail);
  }

  // 해외주식
  if (foreign.count > 0) {
    const gain = foreign.hasPrices ? foreign.currentKrw - foreign.investedKrw : null;
    const gainPct = gain !== null && foreign.investedKrw > 0 ? (gain / foreign.investedKrw) * 100 : null;
    const gc = gain !== null ? (gain >= 0 ? 'gain-up' : 'gain-down') : '';
    const gs = gain !== null && gain >= 0 ? '+' : '';
    const totalStr = foreign.hasPrices ? formatPrice(foreign.currentKrw, 'KRW') : '—';
    const pctStr = gainPct !== null ? `${gs}${gainPct.toFixed(1)}%` : '—';

    let detailHtml = '';
    for (const [currency, g] of Object.entries(foreign.byCurrency)) {
      const cgain = g.hasPrices ? g.current - g.invested : null;
      const cgainPct = cgain !== null && g.invested > 0 ? (cgain / g.invested) * 100 : null;
      const cgc = cgain !== null ? (cgain >= 0 ? 'gain-up' : 'gain-down') : '';
      const cgs = cgain !== null && cgain >= 0 ? '+' : '';
      const rate = state.fxRates[currency];
      const cpctStr = cgainPct !== null ? `${cgs}${cgainPct.toFixed(1)}%` : '—';
      const krwValStr = (rate && g.hasPrices) ? formatPrice(g.current * rate, 'KRW') : null;
      detailHtml += statsGrid([
        ['투자금액', formatPrice(g.invested, currency), ''],
        ['평가금액', g.hasPrices ? formatPrice(g.current, currency) : '—', ''],
        ['손익', cgain !== null ? `${cgs}${formatPrice(Math.abs(cgain), currency)}` : '—', cgc],
        ['수익률', cpctStr, cgc],
      ]);
      if (krwValStr) {
        const krwGain = rate && cgain !== null ? cgain * rate : null;
        const krwGc = krwGain !== null ? (krwGain >= 0 ? 'gain-up' : 'gain-down') : '';
        detailHtml += `<div class="psummary-krw-row"><i class="ph ph-currency-circle-dollar"></i> ${currency} ₩${Math.round(rate).toLocaleString('ko-KR')} · 평가 ${krwValStr}${krwGain !== null ? ` <span class="${krwGc}">(${krwGain >= 0 ? '+' : ''}${formatPrice(Math.abs(krwGain), 'KRW')})</span>` : ''}</div>`;
      }
    }
    html += summaryGroupRow('foreign', '🇺🇸', `해외주식 <span class="psummary-count">${foreign.count}종목</span>`, totalStr, pctStr, gc, detailHtml);
  }

  html += '</div>';
  return html;
}

function renderPortfolioCard(item) {
  const q = state.portfolioPrices[item.symbol];
  const currency = q?.currency || item.currency || 'USD';
  const invested = (item.buyPrice || 0) * (item.qty || 0);

  // Extended-hours price: use post/pre market price when available
  const isPost = q?.marketState === 'POST' && q?.postMarketPrice;
  const isPre  = q?.marketState === 'PRE'  && q?.preMarketPrice;
  const displayPrice  = isPost ? q.postMarketPrice  : isPre ? q.preMarketPrice  : q?.regularMarketPrice;
  const displayChange = isPost ? q.postMarketChange  : isPre ? q.preMarketChange  : q?.regularMarketChange;
  const displayPct    = isPost ? q.postMarketChangePercent : isPre ? q.preMarketChangePercent : q?.regularMarketChangePercent;

  const currentPrice = displayPrice;
  const pct = displayPct;
  const change = displayChange;
  const volume = q?.regularMarketVolume;

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

  // Absolute change amount (no sign — direction shown by color + triangle)
  const absChangeStr = change != null ? formatPrice(Math.abs(change), currency) : '';
  // Triangle + absolute pct
  const triangle = pct != null ? (pct > 0 ? '▲' : pct < 0 ? '▼' : '—') : '';
  const absPctStr = pct != null ? `${triangle} ${Math.abs(pct).toFixed(2)}%` : '';
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

  const cardClass = ['stock-card', dirClass, isExpanded ? 'expanded' : ''].filter(Boolean).join(' ');

  return `
  <div class="${cardClass}" data-symbol="${item.symbol}" data-portfolio="1">
    <div class="stock-card-main">
      <div class="port-row">
        ${stockLogoHtml(item.symbol, q?.korName || item.name)}
        <div class="port-info">
          <div class="port-name">${q?.korName || item.name || item.symbol}</div>
          <div class="port-qty-row"><span class="port-qty-num">${item.qty.toLocaleString('ko-KR')}주</span>${volNum ? `<span class="port-vol-sep"> · </span><span class="port-vol-left">${volNum}</span>` : ''}</div>
          ${regularLineLeft}
        </div>
        <div class="port-price-col">
          <div class="port-line1">
            <span class="port-price ${changeClass}">${currentPrice ? formatPrice(currentPrice, currency) : '—'}</span>
            <span class="port-chg-abs ${changeClass}">${absChangeStr}</span>
          </div>
          <div class="port-line2">
            <span class="port-tri-pct ${changeClass}">${absPctStr}</span>
          </div>
        </div>
        <button class="port-dots-btn" onclick="event.stopPropagation();handlePortfolioCardTap('${item.symbol}')"><i class="ph ph-dots-three-vertical"></i></button>
      </div>
      <div class="port-expand-body">
        <div class="port-gain-summary">
          <span class="port-gain-label">손익</span>
          <span class="port-gain-val ${gainClass}">${gainStr}</span>
          <span class="port-gain-pct ${gainClass}">${pctStr}</span>
          <span class="port-gain-qty">${item.qty}주</span>
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

function togglePortfolioSummary() {
  state.summaryExpanded = !state.summaryExpanded;
  const el = document.querySelector('.portfolio-summary');
  if (el) el.classList.toggle('expanded', state.summaryExpanded);
}

function toggleSummaryGroup(key) {
  state.summaryGroupExpanded[key] = !state.summaryGroupExpanded[key];
  const el = document.querySelector(`.psummary-group-detail[data-key="${key}"]`);
  if (el) { el.classList.toggle('expanded', state.summaryGroupExpanded[key]); return; }
  renderPortfolioHoldings();
}

// ── Landscape Detail Panel ─────────────────────────────────────────────────
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

  const q = state.portfolioPrices[symbol];
  const currentPrice = q?.regularMarketPrice;
  const pct = q?.regularMarketChangePercent;
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

  const name = q?.korName || item.name || item.symbol;
  detail.innerHTML = `
  <div class="ls-detail-content">
    <div class="ls-detail-header">
      <div>
        <div class="ls-detail-name">${name}</div>
        <div class="ls-detail-symbol">${item.symbol} · ${item.qty}주</div>
      </div>
      <div class="ls-detail-price-wrap">
        <div class="ls-detail-price">${currentPrice ? formatPrice(currentPrice, currency) : '—'}</div>
        <div class="stock-change ${getChangeClass(pct)}">${getChangeStr(pct)}</div>
      </div>
    </div>
    <div class="ls-detail-divider"></div>
    <div class="ls-detail-stats">
      <div class="ls-detail-stat">
        <span class="ls-detail-stat-label">매수가</span>
        <span class="ls-detail-stat-value">${formatPrice(item.buyPrice, currency)}</span>
      </div>
      <div class="ls-detail-stat">
        <span class="ls-detail-stat-label">보유 수량</span>
        <span class="ls-detail-stat-value">${item.qty}주</span>
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
    </div>
    ${krwBlock}
    <div class="ls-detail-actions">
      <button class="btn-cancel" style="flex:1" onclick="openPortfolioEditModal(event,'${symbol}')">수정</button>
      <button class="ls-detail-del" onclick="confirmDeletePortfolio(event,'${symbol}')">삭제</button>
    </div>
  </div>`;

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
      ${stockLogoHtml(r.symbol, r.shortname || r.longname)}
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
  const sorted = [...items].sort((a, b) => {
    const gainPct = item => {
      const q = state.portfolioPrices[item.symbol];
      const price = q?.regularMarketPrice;
      if (!price || !item.buyPrice || !item.qty) return -Infinity;
      const invested = item.buyPrice * item.qty;
      return invested > 0 ? (price * item.qty - invested) / invested : -Infinity;
    };
    return gainPct(b) - gainPct(a);
  });
  const cards = sorted.map(item => renderPortfolioCard(item)).join('');
  wrap.innerHTML = `${summary}${cards}`;
}

// ── Portfolio Search ───────────────────────────────────────────────────────
function setPortfolioSearchBtnLoading(loading) {
  const icon = document.querySelector('#home-search-btn i');
  if (!icon) return;
  icon.className = loading ? 'ph ph-circle-notch spinning' : 'ph ph-magnifying-glass';
}

let portfolioSearchTimer;
async function doPortfolioSearch(q) {
  clearTimeout(portfolioSearchTimer);
  if (!q.trim()) { state.portfolioSearchResults = []; renderPortfolioSearch(); setPortfolioSearchBtnLoading(false); return; }
  state.portfolioSearching = true;
  setPortfolioSearchBtnLoading(true);
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
    setPortfolioSearchBtnLoading(false);
  }, 400);
}

// ── Watchlist Inline Search ────────────────────────────────────────────────
function setWatchlistSearchBtnLoading(loading) {
  const icon = document.querySelector('#home-search-btn i');
  if (!icon) return;
  icon.className = loading ? 'ph ph-circle-notch spinning' : 'ph ph-magnifying-glass';
}

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
      ${stockLogoHtml(r.symbol, r.shortname || r.longname)}
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
  if (!q.trim()) { state.watchlistSearchResults = []; renderWatchlistSearch(); setWatchlistSearchBtnLoading(false); return; }
  state.watchlistSearching = true;
  setWatchlistSearchBtnLoading(true);
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
    setWatchlistSearchBtnLoading(false);
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
  buyInput.value = existing?.buyPrice || '';
  qtyInput.value = existing?.qty || '';
  if (!existing && price) buyInput.placeholder = formatPriceInputPlain(price, cur);

  document.getElementById('portfolio-modal-overlay').classList.add('open');
}

function closePortfolioModal() {
  document.getElementById('portfolio-modal-overlay').classList.remove('open');
  setTimeout(() => { portfolioModalData = {}; }, 300);
}

async function savePortfolioModal() {
  const buyPrice = parseFloat(document.getElementById('portfolio-buy-price').value.replace(/,/g, '')) || null;
  const qty = parseFloat(document.getElementById('portfolio-qty').value.replace(/,/g, '')) || null;
  const { symbol, name, currency, existing } = portfolioModalData;

  if (!buyPrice || !qty) { showToast('매수가와 수량을 입력해주세요'); return; }

  const q = state.portfolioPrices[symbol];
  const cur = q?.currency || currency;
  try {
    await savePortfolioItem(symbol, name, buyPrice, qty, cur);
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
  if (tab === 'settings') renderSettings();
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
  const btn = document.getElementById('refresh-btn');
  if (btn) btn.querySelector('i').classList.add('spinning');
  await loadPrices();
  renderHome();
  if (btn) btn.querySelector('i').classList.remove('spinning');
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

// ── Event Listeners ────────────────────────────────────────────────────────
function setupEventListeners() {
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
      if (!v) { state.portfolioSearchResults = []; renderPortfolioSearch(); setPortfolioSearchBtnLoading(false); return; }
      doPortfolioSearch(v);
    } else {
      state.watchlistSearchQ = v;
      if (!v) { state.watchlistSearchResults = []; renderWatchlistSearch(); setWatchlistSearchBtnLoading(false); return; }
      doWatchlistSearch(v);
    }
  });
  homeSearchClear?.addEventListener('click', () => {
    if (homeSearchInput) homeSearchInput.value = '';
    homeSearchClear.classList.remove('visible');
    if (state.currentTab === 'portfolio') {
      state.portfolioSearchResults = [];
      state.portfolioSearchQ = '';
      setPortfolioSearchBtnLoading(false);
      renderPortfolioSearch();
    } else {
      state.watchlistSearchResults = [];
      state.watchlistSearchQ = '';
      setWatchlistSearchBtnLoading(false);
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

  // Modal
  document.getElementById('modal-overlay')?.addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
  });
  document.getElementById('modal-cancel')?.addEventListener('click', closeModal);
  document.getElementById('modal-save')?.addEventListener('click', saveModal);


  // Portfolio modal
  document.getElementById('portfolio-modal-overlay')?.addEventListener('click', e => {
    if (e.target === document.getElementById('portfolio-modal-overlay')) closePortfolioModal();
  });
  document.getElementById('portfolio-modal-cancel')?.addEventListener('click', closePortfolioModal);
  document.getElementById('portfolio-modal-save')?.addEventListener('click', savePortfolioModal);

  // Refresh
  document.getElementById('refresh-btn')?.addEventListener('click', refreshPrices);

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
  document.getElementById('install-btn')?.addEventListener('click', installApp);
  const iClose = document.getElementById('install-close-btn');
  if (iClose) {
    iClose.onclick = (e) => {
      e.preventDefault();
      state.installBannerClosed = true;
      renderBanners();
    };
  }

  // PWA install prompt
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

    // Load data
    state.loading = true;
    renderHome();
    await loadWatchlist();
    await loadPrices();
    await loadPortfolio();
    await loadPortfolioPrices();
    await fetchFxRates();
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
