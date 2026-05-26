// CHZZK Companion - content script
// 그룹화된 팔로잉 사이드바 오버레이

const GROUPS_KEY = 'groups';
const NOTIFY_KEY = 'notify_channels';
const POS_KEY = 'cc_panel_pos';
const SIZE_KEY = 'cc_panel_size';
const PIN_KEY = 'cc_panel_pinned';
let panelPinned = false;
const COLLAPSED_KEY = 'cc_collapsed_groups';
let notifyChannels = new Set();
const OTHER_KEY = '__other__';
const VIEW_KEY = 'cc_view_mode';
const collapsedGroups = new Set();
let viewMode = 'custom';
let searchQuery = '';
let cachedFollowings = [];
let cachedGroups = [];
const OFFLINE_KEY = '__offline__';

async function isLoggedIn() {
  try {
    const r = await fetch('https://comm-api.game.naver.com/nng_main/v1/user/getUserStatus', { credentials: 'include', cache: 'no-store' });
    if (!r.ok) return false;
    const j = await r.json();
    return !!j?.content?.loggedIn;
  } catch (_) { return false; }
}

async function fetchFollowings({ size = 100, maxPages = 20 } = {}) {
  const all = [];
  for (let page = 0; page < maxPages; page++) {
    const res = await fetch(`https://api.chzzk.naver.com/service/v1/channels/followings?page=${page}&size=${size}&sortType=FOLLOW`, { credentials: 'include', cache: 'no-store' });
    if (!res.ok) throw new Error('followings ' + res.status);
    const j = await res.json();
    const content = j?.content ?? {};
    const list = content.followingList ?? content.data ?? content.list ?? [];
    if (!list.length) break;
    all.push(...list);
    const totalPages = content.totalPages ?? null;
    const totalCount = content.totalCount ?? null;
    if (totalPages != null && page + 1 >= totalPages) break;
    if (totalCount != null && all.length >= totalCount) break;
    if (list.length < size) break;
  }
  const seen = new Set();
  return all.map((item) => {
    const ch = item?.channel ?? item;
    const streamer = item?.streamer ?? {};
    const live = item?.liveInfo ?? item?.live ?? streamer?.liveInfo ?? null;
    const category = live?.liveCategoryValue || live?.categoryValue || item?.liveCategoryValue || ch?.liveCategoryValue || '';
    const liveTitle = live?.liveTitle || item?.liveTitle || ch?.liveTitle || '';
    const concurrent = Number(live?.concurrentUserCount ?? item?.concurrentUserCount ?? ch?.concurrentUserCount ?? 0) || 0;
    return {
      channelId: ch?.channelId || '',
      channelName: ch?.channelName || '',
      channelImageUrl: ch?.channelImageUrl || '',
      openLive: !!(ch?.openLive ?? item?.openLive ?? streamer?.openLive ?? live?.openLive ?? live?.status === 'OPEN'),
      liveCategoryValue: category,
      liveTitle,
      concurrentUserCount: concurrent,
    };
  }).filter((x) => x.channelId && !seen.has(x.channelId) && (seen.add(x.channelId), true));
}

async function readGroups() {
  const obj = await chrome.storage.local.get(GROUPS_KEY);
  const list = Array.isArray(obj[GROUPS_KEY]) ? obj[GROUPS_KEY] : [];
  return list.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function formatViewers(n) {
  if (n >= 10000) return (n / 10000).toFixed(n >= 100000 ? 0 : 1) + '만';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let panelEl = null;
let collapsed = false;

function ensurePanel() {
  if (panelEl && document.body.contains(panelEl)) return panelEl;
  panelEl = document.createElement('div');
  panelEl.id = 'cc-followings-panel';
  panelEl.innerHTML = `
    <div class="cc-fp-header">
      <span>팔로잉</span>
      <div class="cc-fp-tabs">
        <button class="cc-fp-tab" data-view="custom" type="button">내 그룹</button>
        <button class="cc-fp-tab" data-view="bygame" type="button">게임별</button>
      </div>
      <button class="cc-fp-pin" type="button" title="위치 고정">📌</button>
      <button class="cc-fp-refresh" type="button" title="새로고침">↻</button>
      <button class="cc-fp-toggle" type="button" title="접기">−</button>
    </div>
    <div class="cc-fp-search-row">
      <input class="cc-fp-search" type="text" placeholder="채널 검색…">
    </div>
    <div class="cc-fp-body"></div>
  `;
  document.body.appendChild(panelEl);
  applyPin();
  panelEl.querySelector('.cc-fp-pin').addEventListener('click', () => {
    panelPinned = !panelPinned;
    chrome.storage.local.set({ [PIN_KEY]: panelPinned });
    applyPin();
  });
  panelEl.querySelector('.cc-fp-refresh').addEventListener('click', refresh);
  panelEl.querySelector('.cc-fp-toggle').addEventListener('click', () => {
    collapsed = !collapsed;
    panelEl.classList.toggle('cc-collapsed', collapsed);
    panelEl.querySelector('.cc-fp-toggle').textContent = collapsed ? '+' : '−';
  });
  enableDrag(panelEl, panelEl.querySelector('.cc-fp-header'));
  restorePos(panelEl);
  restoreSize(panelEl);
  observeResize(panelEl);
  bindGroupToggle(panelEl);
  bindChannelDnD(panelEl);
  bindViewTabs(panelEl);
  bindSearch(panelEl);
  return panelEl;
}

function applyPin() {
  if (!panelEl) return;
  panelEl.classList.toggle('cc-pinned', panelPinned);
  const btn = panelEl.querySelector('.cc-fp-pin');
  if (btn) {
    btn.textContent = panelPinned ? '🔒' : '📌';
    btn.title = panelPinned ? '고정 해제' : '위치 고정';
  }
}

function bindSearch(panel) {
  const input = panel.querySelector('.cc-fp-search');
  input.value = searchQuery;
  input.addEventListener('input', (e) => {
    searchQuery = e.target.value;
    renderBody();
  });
}

function bindViewTabs(panel) {
  panel.querySelectorAll('.cc-fp-tab').forEach((t) => {
    t.addEventListener('click', () => {
      viewMode = t.dataset.view;
      chrome.storage.local.set({ [VIEW_KEY]: viewMode });
      updateActiveTab(panel);
      renderBody();
    });
  });
  updateActiveTab(panel);
}

function updateActiveTab(panel) {
  panel.querySelectorAll('.cc-fp-tab').forEach((t) => t.classList.toggle('cc-active', t.dataset.view === viewMode));
}

function bindChannelDnD(panel) {
  const body = panel.querySelector('.cc-fp-body');
  body.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.cc-ch-row');
    if (!row) return;
    e.dataTransfer.clearData();
    e.dataTransfer.setData('text/cc-channel', JSON.stringify({ cid: row.dataset.cid, fromGid: row.dataset.fromGid }));
    e.dataTransfer.effectAllowed = 'move';
    row.classList.add('cc-dragging');
  });
  body.addEventListener('dragend', (e) => {
    const row = e.target.closest('.cc-ch-row');
    if (row) row.classList.remove('cc-dragging');
    body.querySelectorAll('.cc-drop-target').forEach((el) => el.classList.remove('cc-drop-target'));
  });
  body.addEventListener('dragover', (e) => {
    const groupEl = e.target.closest('.cc-group[data-drop]');
    if (!groupEl) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    body.querySelectorAll('.cc-drop-target').forEach((el) => el !== groupEl && el.classList.remove('cc-drop-target'));
    groupEl.classList.add('cc-drop-target');
  });
  body.addEventListener('dragleave', (e) => {
    const groupEl = e.target.closest('.cc-group[data-drop]');
    if (groupEl && !groupEl.contains(e.relatedTarget)) groupEl.classList.remove('cc-drop-target');
  });
  body.addEventListener('drop', async (e) => {
    const groupEl = e.target.closest('.cc-group[data-drop]');
    if (!groupEl) return;
    e.preventDefault();
    groupEl.classList.remove('cc-drop-target');
    const data = e.dataTransfer.getData('text/cc-channel');
    if (!data) return;
    const { cid, fromGid } = JSON.parse(data);
    const toGid = groupEl.dataset.gid;
    if (fromGid === toGid) return;
    const groups = await readGroups();
    for (const g of groups) g.channelIds = (g.channelIds || []).filter((x) => x !== cid);
    if (toGid !== OTHER_KEY) {
      const target = groups.find((g) => g.id === toGid);
      if (target) target.channelIds.push(cid);
    }
    await chrome.storage.local.set({ [GROUPS_KEY]: groups });
    refresh();
  });
}

function enableDrag(panel, handle) {
  handle.style.cursor = 'move';
  let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
  handle.addEventListener('mousedown', (e) => {
    if (panelPinned) return;
    if (e.target.closest('button')) return;
    const rect = panel.getBoundingClientRect();
    dragging = true; sx = e.clientX; sy = e.clientY; ox = rect.left; oy = rect.top;
    panel.style.right = 'auto'; panel.style.bottom = 'auto';
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const nx = clamp(ox + (e.clientX - sx), 0, window.innerWidth - panel.offsetWidth);
    const ny = clamp(oy + (e.clientY - sy), 0, window.innerHeight - 40);
    panel.style.left = nx + 'px'; panel.style.top = ny + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    chrome.storage.local.set({ [POS_KEY]: { left: panel.style.left, top: panel.style.top } });
  });
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

async function restoreSize(panel) {
  const { [SIZE_KEY]: size } = await chrome.storage.local.get(SIZE_KEY);
  if (!size) return;
  const w = parseInt(size.width), h = parseInt(size.height);
  if (Number.isFinite(w) && w >= 360) panel.style.width = w + 'px';
  if (Number.isFinite(h) && h >= 200) panel.style.height = h + 'px';
}

let resizeSaveTimer = null;
function observeResize(panel) {
  if (!('ResizeObserver' in window)) return;
  const obs = new ResizeObserver(() => {
    clearTimeout(resizeSaveTimer);
    resizeSaveTimer = setTimeout(() => {
      chrome.storage.local.set({ [SIZE_KEY]: { width: panel.offsetWidth, height: panel.offsetHeight } });
    }, 300);
  });
  obs.observe(panel);
}

async function restorePos(panel) {
  const { [POS_KEY]: pos } = await chrome.storage.local.get(POS_KEY);
  if (!pos) return;
  const left = parseInt(pos.left), top = parseInt(pos.top);
  if (isNaN(left) || isNaN(top)) return;
  if (left < 0 || top < 0 || left > window.innerWidth - 40 || top > window.innerHeight - 40) return;
  panel.style.left = pos.left; panel.style.top = pos.top;
  panel.style.right = 'auto'; panel.style.bottom = 'auto';
}

function channelLink(c, gid) {
  const liveCountText = c.openLive && c.concurrentUserCount ? formatViewers(c.concurrentUserCount) : '';
  const live = c.openLive ? `<span class="cc-live-dot" title="LIVE"></span>${liveCountText ? `<span class="cc-live-count">${escapeHtml(liveCountText)}</span>` : ''}` : '';
  const removeBtn = gid && gid !== OTHER_KEY
    ? `<button class="cc-ch-btn cc-ch-remove" data-act="remove-from-group" data-cid="${escapeHtml(c.channelId)}" data-gid="${escapeHtml(gid)}" title="이 그룹에서 제거">↩</button>`
    : '';
  const tooltip = c.openLive && c.liveTitle ? `${c.liveTitle}\n— ${c.channelName}` : c.channelName;
  const isNotify = notifyChannels.has(c.channelId);
  const notifyBtn = `<button class="cc-ch-btn cc-ch-notify ${isNotify ? 'cc-ch-notify-on' : ''}" data-act="notify-toggle" data-cid="${escapeHtml(c.channelId)}" title="${isNotify ? '알림 해제' : '방송 시작 알림 받기'}">${isNotify ? '🔔' : '🔕'}</button>`;
  return `
    <div class="cc-ch-row ${c.openLive ? 'cc-live' : ''}" data-cid="${escapeHtml(c.channelId)}" data-from-gid="${escapeHtml(gid || '')}" draggable="true" title="${escapeHtml(tooltip)}">
      <a class="cc-ch-link" draggable="false" href="https://chzzk.naver.com/live/${encodeURIComponent(c.channelId)}">
        ${c.channelImageUrl ? `<img src="${escapeHtml(c.channelImageUrl)}" onerror="this.style.display='none'">` : '<span class="cc-ch-noimg"></span>'}
        <span class="cc-ch-name">${escapeHtml(c.channelName)}</span>
        ${live}
      </a>
      ${notifyBtn}
      ${removeBtn}
      <button class="cc-ch-btn cc-ch-unfollow" data-act="unfollow" data-cid="${escapeHtml(c.channelId)}" data-cname="${escapeHtml(c.channelName)}" title="팔로우 취소">✕</button>
    </div>
  `;
}

async function unfollowChannel(channelId) {
  const res = await fetch(`https://api.chzzk.naver.com/service/v1/channels/${encodeURIComponent(channelId)}/follow`, {
    method: 'DELETE', credentials: 'include', cache: 'no-store',
  });
  if (!res.ok) throw new Error(`unfollow ${res.status}`);
}

function renderByGame(followings) {
  const sortByLiveThenName = (a, b) => (b.openLive ? 1 : 0) - (a.openLive ? 1 : 0) || (b.concurrentUserCount || 0) - (a.concurrentUserCount || 0) || a.channelName.localeCompare(b.channelName);
  const live = followings.filter((f) => f.openLive);
  const byCat = new Map();
  for (const f of live) {
    const key = f.liveCategoryValue || '카테고리 없음';
    if (!byCat.has(key)) byCat.set(key, []);
    byCat.get(key).push(f);
  }
  const cats = [...byCat.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const colorFor = (s) => {
    let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return `hsl(${h % 360}, 60%, 55%)`;
  };
  const sectionHtml = (id, name, color, channels, isOffline) => {
    const isCollapsed = collapsedGroups.has(id) || (isOffline && !collapsedGroups.size);
    return `
      <div class="cc-group ${isCollapsed ? 'cc-group-collapsed' : ''}" data-gid="${escapeHtml(id)}">
        <div class="cc-group-head" style="--cc-c: ${escapeHtml(color)}" data-act="toggle-group">
          <span class="cc-caret">${isCollapsed ? '▶' : '▼'}</span>
          <span class="cc-group-swatch"></span>
          <span class="cc-group-name">${escapeHtml(name)}</span>
          <span class="cc-group-count">${isOffline ? channels.length : `${channels.length} LIVE`}</span>
        </div>
        <div class="cc-group-body">${channels.map((c) => channelLink(c, null)).join('')}</div>
      </div>
    `;
  };
  const sections = cats.map(([name, list]) => sectionHtml('cat:' + name, name, colorFor(name), list.sort(sortByLiveThenName), false));
  if (!sections.length) return '<div class="cc-empty">현재 라이브 중인 팔로잉 채널이 없습니다.</div>';
  return sections.join('');
}

function renderGrouped(groups, followings) {
  const byId = new Map(followings.map((f) => [f.channelId, f]));
  const assigned = new Set();
  for (const g of groups) for (const id of g.channelIds || []) assigned.add(id);

  const sortByLiveThenName = (a, b) => (b.openLive ? 1 : 0) - (a.openLive ? 1 : 0) || (b.concurrentUserCount || 0) - (a.concurrentUserCount || 0) || a.channelName.localeCompare(b.channelName);

  const sectionHtml = (id, name, color, channels) => {
    const liveCount = channels.filter((c) => c.openLive).length;
    const isCollapsed = collapsedGroups.has(id);
    return `
      <div class="cc-group ${isCollapsed ? 'cc-group-collapsed' : ''}" data-gid="${escapeHtml(id)}" data-drop="1">
        <div class="cc-group-head" style="--cc-c: ${escapeHtml(color)}" data-act="toggle-group">
          <span class="cc-caret">${isCollapsed ? '▶' : '▼'}</span>
          <span class="cc-group-swatch"></span>
          <span class="cc-group-name">${escapeHtml(name)}</span>
          <span class="cc-group-count">${liveCount} / ${channels.length}</span>
        </div>
        <div class="cc-group-body">${channels.length ? channels.map((c) => channelLink(c, id)).join('') : '<div class="cc-empty">채널 없음</div>'}</div>
      </div>
    `;
  };

  const sections = groups.map((g) => {
    const channels = (g.channelIds || []).map((id) => byId.get(id)).filter(Boolean).sort(sortByLiveThenName);
    return sectionHtml(g.id, g.name, g.color || '#1AE192', channels);
  });

  const others = followings.filter((f) => !assigned.has(f.channelId)).sort(sortByLiveThenName);
  if (others.length) sections.push(sectionHtml(OTHER_KEY, '기타', '#666', others));

  if (!groups.length && !followings.length) return '<div class="cc-empty">팔로잉이 없거나 치지직 로그인이 필요합니다.</div>';
  return sections.join('');
}

async function refresh() {
  const t0 = performance.now();
  const log = (label) => console.log(`[cc-fp] +${(performance.now() - t0).toFixed(0)}ms ${label}`);
  log('refresh start');
  const panel = ensurePanel();
  log('panel ensured');
  const body = panel.querySelector('.cc-fp-body');
  body.innerHTML = '<div class="cc-empty">불러오는 중…</div>';
  const logged = await isLoggedIn();
  log(`login check: ${logged}`);
  if (!logged) {
    body.innerHTML = `<div class="cc-empty">치지직 로그인이 필요합니다.<br><br><a href="https://nid.naver.com/nidlogin.login?url=https%3A%2F%2Fchzzk.naver.com%2F" target="_blank" style="color:#1AE192;text-decoration:underline;">로그인하기 →</a></div>`;
    return;
  }
  try {
    log('groups+followings fetch start');
    const [groups, followings] = await Promise.all([readGroups(), fetchFollowings()]);
    log(`fetched groups=${groups.length} followings=${followings.length}`);
    applyDefaultCollapse(groups);
    cachedGroups = groups;
    cachedFollowings = followings;
    renderBody();
    log('rendered');
  } catch (e) {
    log('error: ' + e.message);
    body.innerHTML = `<div class="cc-empty" style="color:#e74c3c">로드 실패: ${escapeHtml(e.message)}</div>`;
  }
}

function renderBody() {
  const panel = ensurePanel();
  const body = panel.querySelector('.cc-fp-body');
  const q = searchQuery.trim().toLowerCase();
  const filtered = q ? cachedFollowings.filter((f) => f.channelName.toLowerCase().includes(q) || (f.liveTitle || '').toLowerCase().includes(q)) : cachedFollowings;
  body.innerHTML = viewMode === 'bygame' ? renderByGame(filtered) : renderGrouped(cachedGroups, filtered);
}

async function loadCollapsed() {
  const obj = await chrome.storage.local.get([COLLAPSED_KEY, VIEW_KEY, NOTIFY_KEY, PIN_KEY]);
  const arr = obj[COLLAPSED_KEY];
  if (Array.isArray(arr)) for (const id of arr) collapsedGroups.add(id);
  else { collapsedGroups.add(OTHER_KEY); collapsedGroups.add(OFFLINE_KEY); }
  if (obj[VIEW_KEY] === 'bygame') viewMode = 'bygame';
  if (Array.isArray(obj[NOTIFY_KEY])) notifyChannels = new Set(obj[NOTIFY_KEY]);
  if (obj[PIN_KEY] === true) panelPinned = true;
}

function saveCollapsed() {
  chrome.storage.local.set({ [COLLAPSED_KEY]: [...collapsedGroups] });
}

let defaultCollapseApplied = false;
function applyDefaultCollapse(groups) {
  if (defaultCollapseApplied) return;
  defaultCollapseApplied = true;
}

function bindGroupToggle(panel) {
  panel.querySelector('.cc-fp-body').addEventListener('click', async (e) => {
    const notifyBtn = e.target.closest('[data-act="notify-toggle"]');
    if (notifyBtn) {
      e.preventDefault(); e.stopPropagation();
      const cid = notifyBtn.dataset.cid;
      const wasOn = notifyChannels.has(cid);
      if (wasOn) notifyChannels.delete(cid); else notifyChannels.add(cid);
      await chrome.storage.local.set({ [NOTIFY_KEY]: [...notifyChannels] });
      chrome.runtime.sendMessage({ type: wasOn ? 'clearState' : 'seedState', channelId: cid });
      renderBody();
      return;
    }
    const removeBtn = e.target.closest('[data-act="remove-from-group"]');
    if (removeBtn) {
      e.preventDefault(); e.stopPropagation();
      const cid = removeBtn.dataset.cid;
      const gid = removeBtn.dataset.gid;
      const groups = await readGroups();
      const g = groups.find((x) => x.id === gid);
      if (g) g.channelIds = (g.channelIds || []).filter((x) => x !== cid);
      await chrome.storage.local.set({ [GROUPS_KEY]: groups });
      refresh();
      return;
    }
    const unfollowBtn = e.target.closest('[data-act="unfollow"]');
    if (unfollowBtn) {
      e.preventDefault(); e.stopPropagation();
      const cid = unfollowBtn.dataset.cid;
      const cname = unfollowBtn.dataset.cname;
      if (!confirm(`"${cname}" 팔로우를 취소할까요?`)) return;
      unfollowBtn.disabled = true;
      try {
        await unfollowChannel(cid);
        const groups = await readGroups();
        for (const g of groups) g.channelIds = (g.channelIds || []).filter((x) => x !== cid);
        await chrome.storage.local.set({ [GROUPS_KEY]: groups });
        refresh();
      } catch (err) {
        alert('팔로우 취소 실패: ' + err.message);
        unfollowBtn.disabled = false;
      }
      return;
    }
    const head = e.target.closest('[data-act="toggle-group"]');
    if (!head) return;
    const groupEl = head.closest('.cc-group');
    if (!groupEl) return;
    const gid = groupEl.dataset.gid;
    if (collapsedGroups.has(gid)) collapsedGroups.delete(gid);
    else collapsedGroups.add(gid);
    groupEl.classList.toggle('cc-group-collapsed', collapsedGroups.has(gid));
    head.querySelector('.cc-caret').textContent = collapsedGroups.has(gid) ? '▶' : '▼';
    saveCollapsed();
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[GROUPS_KEY]) refresh();
  if (changes[NOTIFY_KEY]) {
    notifyChannels = new Set(Array.isArray(changes[NOTIFY_KEY].newValue) ? changes[NOTIFY_KEY].newValue : []);
    renderBody();
  }
});

loadCollapsed().then(refresh);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'cc-live-toast' && msg.channel) showLiveToast(msg.channel);
});

let toastStackEl = null;
function ensureToastStack() {
  if (toastStackEl && document.body.contains(toastStackEl)) return toastStackEl;
  toastStackEl = document.createElement('div');
  toastStackEl.id = 'cc-toast-stack';
  document.body.appendChild(toastStackEl);
  return toastStackEl;
}

function showLiveToast(ch) {
  const stack = ensureToastStack();
  const existing = stack.querySelector(`[data-cid="${CSS.escape(ch.channelId)}"]`);
  if (existing) return;
  const toast = document.createElement('div');
  toast.className = 'cc-toast';
  toast.dataset.cid = ch.channelId;
  toast.innerHTML = `
    ${ch.channelImageUrl ? `<img class="cc-toast-img" src="${escapeHtml(ch.channelImageUrl)}">` : ''}
    <div class="cc-toast-body">
      <div class="cc-toast-name">${escapeHtml(ch.channelName)} <span class="cc-toast-live">LIVE</span></div>
      ${ch.liveTitle ? `<div class="cc-toast-title" title="${escapeHtml(ch.liveTitle)}">${escapeHtml(ch.liveTitle)}</div>` : ''}
      ${ch.liveCategoryValue ? `<div class="cc-toast-cat">${escapeHtml(ch.liveCategoryValue)}</div>` : ''}
      <div class="cc-toast-actions">
        <a class="cc-toast-go" href="https://chzzk.naver.com/live/${encodeURIComponent(ch.channelId)}">방송 보러가기</a>
        <button class="cc-toast-close" type="button">닫기</button>
      </div>
    </div>
  `;
  stack.appendChild(toast);
  const close = () => { toast.classList.add('cc-toast-leaving'); setTimeout(() => toast.remove(), 250); };
  toast.querySelector('.cc-toast-close').addEventListener('click', close);
  toast.querySelector('.cc-toast-go').addEventListener('click', close);
}
