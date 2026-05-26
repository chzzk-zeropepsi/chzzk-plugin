// CHZZK Companion - 북마크 페이지 주입 (라이브: 추가 / VOD: 점프 패널)
// 같은 content_script 컨텍스트에서 동작

const BM_KEY = 'bookmarks';

async function readBookmarks() {
  const obj = await chrome.storage.local.get(BM_KEY);
  return obj[BM_KEY] || {};
}
async function writeBookmarks(data) {
  await chrome.storage.local.set({ [BM_KEY]: data });
}

async function liveStatus(channelId) {
  const res = await fetch(`https://api.chzzk.naver.com/polling/v2/channels/${encodeURIComponent(channelId)}/live-status`, { credentials: 'include', cache: 'no-store' });
  if (!res.ok) return null;
  const j = await res.json();
  return j?.content || null;
}

async function channelMeta(channelId) {
  const res = await fetch(`https://api.chzzk.naver.com/service/v1/channels/${encodeURIComponent(channelId)}`, { credentials: 'include', cache: 'no-store' });
  if (!res.ok) return null;
  const j = await res.json();
  return j?.content || null;
}

async function videoInfo(videoNo) {
  const res = await fetch(`https://api.chzzk.naver.com/service/v1/videos/${encodeURIComponent(videoNo)}`, { credentials: 'include', cache: 'no-store' });
  if (!res.ok) return null;
  const j = await res.json();
  return j?.content || null;
}

function pathMatch(re) { return location.pathname.match(re); }
function fmtTime(s) {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// ───── 라이브: 북마크 추가 (팔로잉 패널 헤더에 버튼 주입) ─────
async function setupLiveBookmark() {
  const m = pathMatch(/\/live\/([^/?#]+)/);
  if (!m) return;
  const channelId = m[1];
  const [status, meta] = await Promise.all([liveStatus(channelId), channelMeta(channelId)]);
  if (!status || status.status !== 'OPEN' || !status.openDate) return;
  const liveId = String(status.liveId || status.openDate);
  const openDateMs = parseChzzkDate(status.openDate);
  if (!openDateMs) return;
  const channelName = meta?.channelName || status.channel?.channelName || '';

  await waitForPanel();
  const header = document.querySelector('#cc-followings-panel .cc-fp-header');
  if (!header) return;
  if (header.querySelector('#cc-bm-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'cc-bm-btn';
  btn.type = 'button';
  btn.title = '현재 시점 북마크 추가';
  btn.textContent = '🔖 북마크';
  const refreshBtn = header.querySelector('.cc-fp-refresh');
  header.insertBefore(btn, refreshBtn);
  btn.addEventListener('click', async () => {
    const offset = Math.max(0, Math.floor((Date.now() - openDateMs) / 1000));
    const label = prompt(`라벨을 입력하세요 (현재 ${fmtTime(offset)})`, '');
    if (label === null) return;
    const all = await readBookmarks();
    const entry = all[liveId] || { channelId, channelName, liveTitle: status.liveTitle || '', openDate: status.openDate, items: [] };
    if (!entry.channelName && channelName) entry.channelName = channelName;
    entry.items.push({ at: offset, label: (label || '').trim(), createdAt: Date.now() });
    entry.items.sort((a, b) => a.at - b.at);
    all[liveId] = entry;
    await writeBookmarks(all);
    flashBtn(btn);
  });
}

function waitForPanel() {
  return new Promise((resolve) => {
    if (document.querySelector('#cc-followings-panel .cc-fp-header')) return resolve();
    const obs = new MutationObserver(() => {
      if (document.querySelector('#cc-followings-panel .cc-fp-header')) { obs.disconnect(); resolve(); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { obs.disconnect(); resolve(); }, 5000);
  });
}

function flashBtn(btn) {
  btn.classList.add('cc-bm-flash');
  setTimeout(() => btn.classList.remove('cc-bm-flash'), 800);
}

function parseChzzkDate(s) {
  if (!s) return null;
  const iso = s.includes('T') ? s : s.replace(' ', 'T') + '+09:00';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function flashFab(fab, text) {
  const orig = fab.innerHTML;
  fab.innerHTML = '✓ ' + text;
  fab.classList.add('cc-bm-flash');
  setTimeout(() => { fab.innerHTML = orig; fab.classList.remove('cc-bm-flash'); }, 1200);
}

// ───── VOD: 북마크 점프 패널 ─────
async function setupVodBookmark() {
  const m = pathMatch(/\/video\/([^/?#]+)/);
  if (!m) return;
  const videoNo = m[1];
  const detail = await videoDetail(videoNo);
  if (!detail) return;
  const channelId = detail.channel?.channelId;
  const liveOpenDate = detail.liveOpenDate;
  if (!channelId || !liveOpenDate) return;
  const all = await readBookmarks();
  const sameChannel = Object.values(all).filter((e) => e.channelId === channelId);
  if (!sameChannel.length) return;
  const liveMs = parseChzzkDate(liveOpenDate);
  let matched = sameChannel.filter((e) => e.openDate === liveOpenDate);
  if (!matched.length && liveMs) {
    matched = sameChannel.filter((e) => {
      const t = parseChzzkDate(e.openDate);
      return t && Math.abs(t - liveMs) < 60 * 1000;
    });
  }
  if (!matched.length) return;
  const items = matched.flatMap((e) => (e.items || []).map((it) => ({ ...it, _date: e.openDate }))).sort((a, b) => a.at - b.at);
  if (!items.length) return;
  injectVodPanel(items);
}

const VOD_POS_KEY = 'cc_bm_vod_pos';

function injectVodPanel(items) {
  document.getElementById('cc-bm-vod')?.remove();
  const el = document.createElement('div');
  el.id = 'cc-bm-vod';
  el.innerHTML = `
    <div class="cc-bm-vod-head">
      <span>🔖 북마크 ${items.length}</span>
      <button class="cc-bm-vod-collapse" type="button" title="접기">−</button>
    </div>
    <div class="cc-bm-vod-body">
      ${items.map((it) => `
        <button class="cc-bm-vod-item" type="button" data-at="${it.at}">
          <span class="cc-bm-vod-time">${fmtTime(it.at)}</span>
          <span class="cc-bm-vod-label">${esc(it.label || '(라벨 없음)')}</span>
        </button>
      `).join('')}
    </div>
  `;
  document.body.appendChild(el);
  let collapsed = false;
  el.querySelector('.cc-bm-vod-collapse').addEventListener('click', () => {
    collapsed = !collapsed;
    el.classList.toggle('cc-bm-vod-collapsed', collapsed);
    el.querySelector('.cc-bm-vod-collapse').textContent = collapsed ? '+' : '−';
  });
  el.querySelector('.cc-bm-vod-body').addEventListener('click', (e) => {
    const btn = e.target.closest('.cc-bm-vod-item');
    if (!btn) return;
    const at = parseFloat(btn.dataset.at);
    const v = document.querySelector('video');
    if (v) { try { v.currentTime = at; v.play?.(); } catch (_) {} }
  });
  enableVodPanelDrag(el);
  restoreVodPanelPos(el);
}

function enableVodPanelDrag(panel) {
  const head = panel.querySelector('.cc-bm-vod-head');
  head.style.cursor = 'move';
  let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
  head.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return;
    const rect = panel.getBoundingClientRect();
    dragging = true; sx = e.clientX; sy = e.clientY; ox = rect.left; oy = rect.top;
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const nx = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, ox + (e.clientX - sx)));
    const ny = Math.max(0, Math.min(window.innerHeight - 40, oy + (e.clientY - sy)));
    panel.style.left = nx + 'px';
    panel.style.top = ny + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    chrome.storage.local.set({ [VOD_POS_KEY]: { left: panel.style.left, top: panel.style.top } });
  });
}

async function restoreVodPanelPos(panel) {
  const { [VOD_POS_KEY]: pos } = await chrome.storage.local.get(VOD_POS_KEY);
  if (!pos) return;
  const left = parseInt(pos.left), top = parseInt(pos.top);
  if (!Number.isFinite(left) || !Number.isFinite(top)) return;
  if (left < 0 || top < 0 || left > window.innerWidth - 40 || top > window.innerHeight - 40) return;
  panel.style.left = pos.left;
  panel.style.top = pos.top;
}

async function videoDetail(videoNo) {
  try {
    const res = await fetch(`https://api.chzzk.naver.com/service/v3/videos/${encodeURIComponent(videoNo)}`, { credentials: 'include', cache: 'no-store' });
    if (!res.ok) return null;
    const j = await res.json();
    return j?.content || null;
  } catch (_) { return null; }
}

(async function init() {
  if (location.pathname.startsWith('/live/')) await setupLiveBookmark();
  if (location.pathname.startsWith('/video/')) await setupVodBookmark();
})();

let lastPath = location.pathname;
setInterval(() => {
  if (location.pathname === lastPath) return;
  lastPath = location.pathname;
  document.getElementById('cc-bm-btn')?.remove();
  document.getElementById('cc-bm-vod')?.remove();
  if (location.pathname.startsWith('/live/')) setupLiveBookmark();
  if (location.pathname.startsWith('/video/')) setupVodBookmark();
}, 1500);
