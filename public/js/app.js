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


function renderStockCard(item) {
  if (!item || !item.symbol) return ''; // Safety check
  const q = state.prices[item.symbol];
  const price = q?.regularMarketPrice;
  const pct = q?.regularMarketChangePercent;
  const currency = q?.currency || item.currency || 'USD';

  const atAlert = item.alertPrice && price && price <= item.alertPrice;
  const atTarget = item.targetPrice && price && price >= item.targetPrice;

  let badge = '';
  if (atTarget) badge = `<div class="reached-badge target"><i class="ph-fill ph-target"></i> 목표가 도달</div>`;
  else if (atAlert) badge = `<div class="reached-badge alert"><i class="ph-fill ph-bell-simple-ringing"></i> 관심가 도달</div>`;

  const cardClass = ['stock-card', atAlert ? 'alert-reached' : '', atTarget ? 'target-reached' : ''].filter(Boolean).join(' ');

  return `
  <div class="${cardClass}" data-symbol="${item.symbol}" onclick="handleCardTap('${item.symbol}')">
    <div class="stock-card-main">
      ${badge}
      <div class="stock-card-top">
        <div>
          <div class="stock-name">${item.name || item.symbol}</div>
          <div class="stock-symbol">${item.symbol}</div>
        </div>
        <div class="stock-price-wrap">
          <div class="stock-price">${price ? formatPrice(price, currency) : '—'}</div>
          <div class="stock-change ${getChangeClass(pct)}">${getChangeStr(pct)}</div>
        </div>
      </div>
      <div class="stock-targets">
        <div class="target-badge alert ${!item.alertPrice ? 'unset' : ''}">
          <div class="target-badge-label">관심가</div>
          <div class="target-badge-value">${item.alertPrice ? formatPrice(item.alertPrice, currency) : '미설정'}</div>
        </div>
        <div class="target-badge goal ${!item.targetPrice ? 'unset' : ''}">
          <div class="target-badge-label">목표가</div>
          <div class="target-badge-value">${item.targetPrice ? formatPrice(item.targetPrice, currency) : '미설정'}</div>
        </div>
      </div>
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
        <button class="btn-primary" onclick="switchTab('search')">종목 검색하기</button>
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
  renderSearchResults();
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

function setupSwipeEvents() {
  const list = document.getElementById('home-list');
  if (!list) return;

  // touchstart에서 카드 참조를 직접 저장 — touchend에서 재탐색하면 target이 달라질 수 있음
  let activeCard = null;

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

  // 터치 이벤트
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

  // 마우스 이벤트 (데스크탑 테스트용) — mouseup은 document에서 받아 드래그 범위 밖도 처리
  let mouseCard = null;
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

function formatPriceInputPlain(price, currency) {
  if (currency === 'KRW' || currency === 'JPY') return Math.round(price).toLocaleString();
  return price.toFixed(2);
}

// ── Portfolio Rendering ────────────────────────────────────────────────────
function renderPortfolioSummary() {
  const items = Object.values(state.portfolio);
  if (!items.length) return '';

  const groups = {};
  for (const item of items) {
    const q = state.portfolioPrices[item.symbol];
    const currency = q?.currency || item.currency || 'USD';
    if (!groups[currency]) groups[currency] = { invested: 0, current: 0, hasPrices: false };
    if (item.buyPrice && item.qty) {
      const price = q?.regularMarketPrice;
      groups[currency].invested += item.buyPrice * item.qty;
      if (price) { groups[currency].current += price * item.qty; groups[currency].hasPrices = true; }
    }
  }

  const numCurrencies = Object.keys(groups).length;
  const currencyNames = { KRW: '원화', USD: '달러', JPY: '엔화' };

  const rows = Object.entries(groups).map(([currency, g]) => {
    const gain = g.hasPrices ? g.current - g.invested : null;
    const gainPct = (gain !== null && g.invested > 0) ? (gain / g.invested) * 100 : null;
    const gainClass = gain !== null ? (gain >= 0 ? 'up' : 'down') : '';
    const gainSign = gain !== null && gain >= 0 ? '+' : '';
    const currencyLabel = numCurrencies > 1
      ? `<div class="portfolio-currency-label">${currencyNames[currency] || currency}</div>` : '';
    return `
    <div class="portfolio-summary-block">
      ${currencyLabel}
      <div class="portfolio-total-value">${g.hasPrices ? formatPrice(g.current, currency) : '—'}</div>
      <div class="portfolio-stats-row">
        <div class="portfolio-stat">
          <div class="portfolio-stat-label">투자금액</div>
          <div class="portfolio-stat-value">${formatPrice(g.invested, currency)}</div>
        </div>
        <div class="portfolio-stat">
          <div class="portfolio-stat-label">평가손익</div>
          <div class="portfolio-stat-value ${gainClass}">${gain !== null ? `${gainSign}${formatPrice(Math.abs(gain), currency)}` : '—'}</div>
        </div>
        <div class="portfolio-stat">
          <div class="portfolio-stat-label">수익률</div>
          <div class="portfolio-stat-value ${gainClass}">${gainPct !== null ? `${gainSign}${gainPct.toFixed(2)}%` : '—'}</div>
        </div>
      </div>
    </div>`;
  }).join('');

  return `<div class="portfolio-summary"><div class="portfolio-total-label">총 평가금액</div>${rows}</div>`;
}

function renderPortfolioCard(item) {
  const q = state.portfolioPrices[item.symbol];
  const currentPrice = q?.regularMarketPrice;
  const pct = q?.regularMarketChangePercent;
  const currency = q?.currency || item.currency || 'USD';
  const invested = (item.buyPrice || 0) * (item.qty || 0);
  const currentVal = currentPrice ? currentPrice * item.qty : null;
  const gain = currentVal !== null ? currentVal - invested : null;
  const gainPct = gain !== null && invested > 0 ? (gain / invested) * 100 : null;
  const gainClass = gain !== null ? (gain >= 0 ? 'up' : 'down') : '';
  const gainSign = gain !== null && gain >= 0 ? '+' : '';

  return `
  <div class="portfolio-card">
    <div class="portfolio-card-top">
      <div>
        <div class="portfolio-card-name">${item.name || item.symbol}</div>
        <div class="portfolio-card-symbol">${item.symbol} · ${item.qty}주</div>
      </div>
      <div class="portfolio-card-price">
        <div class="portfolio-card-current">${currentPrice ? formatPrice(currentPrice, currency) : '—'}</div>
        <div class="portfolio-card-change ${getChangeClass(pct)}">${getChangeStr(pct)}</div>
      </div>
    </div>
    <div class="portfolio-card-stats">
      <div class="portfolio-card-stat">
        <div class="portfolio-card-stat-label">매수가</div>
        <div class="portfolio-card-stat-value">${formatPrice(item.buyPrice, currency)}</div>
      </div>
      <div class="portfolio-card-stat">
        <div class="portfolio-card-stat-label">투자금액</div>
        <div class="portfolio-card-stat-value">${formatPrice(invested, currency)}</div>
      </div>
      <div class="portfolio-card-stat">
        <div class="portfolio-card-stat-label">평가금액</div>
        <div class="portfolio-card-stat-value">${currentVal !== null ? formatPrice(currentVal, currency) : '—'}</div>
      </div>
      <div class="portfolio-card-stat">
        <div class="portfolio-card-stat-label">수익률</div>
        <div class="portfolio-card-stat-value ${gainClass}">${gainPct !== null ? `${gainSign}${gainPct.toFixed(2)}%` : '—'}</div>
      </div>
    </div>
    <button class="portfolio-card-del" onclick="confirmDeletePortfolio('${item.symbol}')"><i class="ph ph-trash"></i></button>
  </div>`;
}

function renderPortfolioSearch() {
  const wrap = document.getElementById('portfolio-search-results');
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

function renderPortfolioHoldings() {
  const wrap = document.getElementById('portfolio-holdings');
  if (!wrap) return;
  const items = Object.values(state.portfolio);

  if (!items.length) {
    wrap.innerHTML = `
      <div class="empty">
        <div class="empty-icon"><i class="ph ph-wallet"></i></div>
        <div class="empty-title">보유 종목이 없습니다</div>
        <div class="empty-sub">위에서 종목을 검색하여<br>내 주식을 추가하세요</div>
      </div>`;
    return;
  }

  const summary = renderPortfolioSummary();
  const cards = items.map(item => renderPortfolioCard(item)).join('');
  wrap.innerHTML = `${summary}<div class="section-title" style="margin-top:0">보유 종목</div>${cards}`;
}

// ── Portfolio Search ───────────────────────────────────────────────────────
let portfolioSearchTimer;
async function doPortfolioSearch(q) {
  clearTimeout(portfolioSearchTimer);
  if (!q.trim()) { state.portfolioSearchResults = []; renderPortfolioSearch(); return; }
  state.portfolioSearching = true;
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
  showToast(existing ? '✅ 수정되었습니다' : '✅ 추가되었습니다');
}

async function confirmDeletePortfolio(symbol) {
  if (!confirm(`${state.portfolio[symbol]?.name || symbol} 종목을 삭제할까요?`)) return;
  try {
    await deletePortfolioItem(symbol);
    renderPortfolioHoldings();
    showToast('종목이 삭제되었습니다');
  } catch {
    showToast('삭제 중 오류가 발생했습니다');
  }
}

// ── Tabs ───────────────────────────────────────────────────────────────────
function switchTab(tab) {
  state.currentTab = tab;
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`screen-${tab}`)?.classList.add('active');
  document.getElementById(`tab-${tab}`)?.classList.add('active');

  if (tab === 'home') renderHome();
  if (tab === 'search') { setTimeout(() => document.getElementById('search-input')?.focus(), 100); }
  if (tab === 'settings') renderSettings();
  if (tab === 'portfolio') {
    renderPortfolioHoldings();
    renderPortfolioSearch();
    if (Object.keys(state.portfolio).length) {
      loadPortfolioPrices().then(() => {
        if (state.currentTab === 'portfolio') renderPortfolioHoldings();
      });
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
      await loadPortfolioPrices();
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
  ['home', 'search', 'portfolio', 'settings'].forEach(tab => {
    const btn = document.getElementById(`tab-${tab}`);
    if (btn) btn.onclick = () => switchTab(tab);
  });

  // Search
  const searchInput = document.getElementById('search-input');
  const searchClear = document.getElementById('search-clear');
  searchInput?.addEventListener('input', e => {
    const v = e.target.value;
    searchClear.classList.toggle('visible', !!v);
    doSearch(v);
  });
  searchClear?.addEventListener('click', () => {
    searchInput.value = '';
    searchClear.classList.remove('visible');
    state.searchResults = [];
    renderSearchResults();
    searchInput.focus();
  });

  // Modal
  document.getElementById('modal-overlay')?.addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
  });
  document.getElementById('modal-cancel')?.addEventListener('click', closeModal);
  document.getElementById('modal-save')?.addEventListener('click', saveModal);

  // Portfolio search
  const portfolioSearchInput = document.getElementById('portfolio-search-input');
  const portfolioSearchClear = document.getElementById('portfolio-search-clear');
  portfolioSearchInput?.addEventListener('input', e => {
    const v = e.target.value;
    state.portfolioSearchQ = v;
    portfolioSearchClear?.classList.toggle('visible', !!v);
    if (!v) { state.portfolioSearchResults = []; renderPortfolioSearch(); return; }
    doPortfolioSearch(v);
  });
  portfolioSearchClear?.addEventListener('click', () => {
    if (portfolioSearchInput) portfolioSearchInput.value = '';
    portfolioSearchClear.classList.remove('visible');
    state.portfolioSearchResults = [];
    state.portfolioSearchQ = '';
    renderPortfolioSearch();
    portfolioSearchInput?.focus();
  });

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
    state.loading = false;
    renderHome();

    switchTab('home');
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
