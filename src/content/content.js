// CHZZK Companion - content script
// 그룹화된 팔로잉 사이드바 오버레이

const GROUPS_KEY = 'groups';
const NOTIFY_KEY = 'notify_channels';
const FAV_KEY = 'favorite_channels';
const FAV_ONLY_KEY = 'cc_fav_only';
let favoriteChannels = new Set();
let favOnly = false;
const POS_KEY = 'cc_panel_pos';
const SIZE_KEY = 'cc_panel_size';
const PIN_KEY = 'cc_panel_pinned';
const OPACITY_KEY = 'cc_panel_opacity';
const ICONIZED_KEY = 'cc_panel_iconized';
const ICON_POS_KEY = 'cc_panel_icon_pos';
const PANEL_COLLAPSED_KEY = 'cc_panel_collapsed';
let panelPinned = false;
let panelOpacity = 0.97;
let panelIconized = false;
const COLLAPSED_KEY = 'cc_collapsed_groups';
let notifyChannels = new Set();
const OTHER_KEY = '__other__';
const VIEW_KEY = 'cc_view_mode';
const SCROLL_KEY = 'cc_panel_scroll';
const LIVE_ONLY_KEY = 'cc_live_only';
let liveOnly = false;
const collapsedGroups = new Set();
let viewMode = 'custom';
let searchQuery = '';

// 한글 음절을 초성 문자열로 변환 (예: "치지직" → "ㅊㅈㅈ"). 비한글은 그대로 유지.
const HANGUL_INITIALS = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
function toInitials(str) {
  let out = '';
  for (const ch of String(str)) {
    const code = ch.charCodeAt(0);
    if (code >= 0xAC00 && code <= 0xD7A3) out += HANGUL_INITIALS[Math.floor((code - 0xAC00) / 588)];
    else out += ch.toLowerCase();
  }
  return out;
}
let cachedFollowings = [];
let cachedGroups = [];
const watchParties = new Map(); // channelId -> { no, tag, type, drops }
const liveTags = new Map(); // channelId -> string[]
let addingTo = null; // null | 'root' | groupId

window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  if (e.data?.source !== 'cc-lives') return;
  let changed = false;
  for (const it of (e.data.data || [])) {
    if (!it.channelId) continue;
    const hasInfo = it.watchPartyNo || it.dropsCampaignNo;
    if (hasInfo) {
      watchParties.set(it.channelId, {
        no: it.watchPartyNo || null,
        tag: it.watchPartyTag || '',
        type: it.watchPartyType || '',
        drops: it.dropsCampaignNo || null,
      });
      changed = true;
    } else if (watchParties.has(it.channelId)) {
      watchParties.delete(it.channelId);
      changed = true;
    }
    if (Array.isArray(it.tags) && it.tags.length) {
      liveTags.set(it.channelId, it.tags);
      changed = true;
    }
  }
  if (changed && cachedFollowings.length) renderBody();
});
const OFFLINE_KEY = '__offline__';

async function isLoggedIn() {
  try {
    const r = await fetch('https://comm-api.game.naver.com/nng_main/v1/user/getUserStatus', { credentials: 'include', cache: 'no-store' });
    if (!r.ok) return false;
    const j = await r.json();
    return !!j?.content?.loggedIn;
  } catch (_) { return false; }
}

async function fetchFollowingLives() {
  try {
    const res = await fetch('https://api.chzzk.naver.com/service/v1/channels/following-lives?sortType=RECOMMEND', { credentials: 'include', cache: 'no-store' });
    if (!res.ok) return;
    const j = await res.json();
    const list = j?.content?.followingList || [];
    for (const it of list) {
      const cid = it.channelId || it.channel?.channelId;
      if (!cid) continue;
      const li = it.liveInfo || {};
      if (li.watchPartyNo || li.dropsCampaignNo) {
        watchParties.set(cid, {
          no: li.watchPartyNo || null,
          tag: li.watchPartyTag || '',
          type: li.watchPartyType || '',
          drops: li.dropsCampaignNo || null,
        });
      } else {
        watchParties.delete(cid);
      }
      if (Array.isArray(li.tags) && li.tags.length) liveTags.set(cid, li.tags);
    }
  } catch (_) {}
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

function newGroupId() { return 'g_' + Math.random().toString(36).slice(2, 10); }

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
      <div class="cc-fp-row1">
        <span>팔로잉</span>
        <button class="cc-fp-pin" type="button" title="위치 고정">📌</button>
        <button class="cc-fp-refresh" type="button" title="새로고침">↻</button>
        <button class="cc-fp-toggle" type="button" title="패널 접기">−</button>
        <button class="cc-fp-iconize" type="button" title="아이콘으로 축소">◇</button>
      </div>
      <div class="cc-fp-tabs">
        <button class="cc-fp-tab" data-view="custom" type="button">내 그룹</button>
        <button class="cc-fp-tab" data-view="bygame" type="button">게임별</button>
        <button class="cc-fp-tab" data-view="subscribe" type="button" title="내 구독 채널">⭐</button>
        <button class="cc-fp-tab" data-view="watchparty" type="button" title="같이보기">🎬</button>
        <button class="cc-fp-tab" data-view="drops" type="button" title="드롭스">🎁</button>
        <button class="cc-fp-tab" data-view="bytag" type="button" title="태그별">🏷</button>
      </div>
      <div class="cc-fp-row2">
        <button class="cc-fp-live-only" type="button" title="라이브만 보기">🔴 LIVE만</button>
        <button class="cc-fp-fav-only" type="button" title="즐겨찾기만 보기">⚡만</button>
        <button class="cc-fp-add-group" type="button" title="새 최상위 그룹">+ 그룹</button>
      </div>
    </div>
    <div class="cc-fp-search-row">
      <button class="cc-fp-expand-toggle" type="button" title="모두 펼치기/접기">⊞</button>
      <input class="cc-fp-search" type="text" placeholder="채널 검색…">
    </div>
    <div class="cc-fp-body"></div>
  `;
  document.body.appendChild(panelEl);
  applyPin();
  applyLiveOnly();
  applyFavOnly();
  applyOpacity();
  applyIconized();
  applyPanelCollapsed();
  panelEl.querySelector('.cc-fp-iconize').addEventListener('click', (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const iconSize = 44;
    const left = Math.max(0, Math.min(window.innerWidth - iconSize, rect.left + rect.width / 2 - iconSize / 2));
    const top = Math.max(0, Math.min(window.innerHeight - iconSize, rect.top + rect.height / 2 - iconSize / 2));
    panelIconized = true;
    chrome.storage.local.set({ [ICONIZED_KEY]: true, [ICON_POS_KEY]: { left: left + 'px', top: top + 'px' } });
    applyIconized();
  });
  const toggleBtn = panelEl.querySelector('.cc-fp-expand-toggle');
  const syncToggleBtn = () => {
    const anyCollapsed = panelEl.querySelectorAll('.cc-group.cc-group-collapsed').length > 0;
    toggleBtn.textContent = anyCollapsed ? '⊞ 모두 펼치기' : '⊟ 모두 접기';
  };
  toggleBtn.addEventListener('click', () => {
    const anyCollapsed = panelEl.querySelectorAll('.cc-group.cc-group-collapsed').length > 0;
    if (anyCollapsed) {
      collapsedGroups.clear();
    } else {
      panelEl.querySelectorAll('[data-gid]').forEach((el) => {
        const gid = el.dataset.gid;
        if (gid) collapsedGroups.add(gid);
      });
    }
    saveCollapsed();
    renderBody();
    syncToggleBtn();
  });
  setTimeout(syncToggleBtn, 100);
  panelEl.querySelector('.cc-fp-add-group').addEventListener('click', () => {
    addingTo = 'root';
    renderBody();
    setTimeout(() => panelEl.querySelector('.cc-group-add-input input')?.focus(), 0);
  });
  panelEl.querySelector('.cc-fp-live-only').addEventListener('click', () => {
    liveOnly = !liveOnly;
    chrome.storage.local.set({ [LIVE_ONLY_KEY]: liveOnly });
    applyLiveOnly();
    renderBody();
  });
  panelEl.querySelector('.cc-fp-fav-only').addEventListener('click', () => {
    favOnly = !favOnly;
    chrome.storage.local.set({ [FAV_ONLY_KEY]: favOnly });
    applyFavOnly();
    renderBody();
  });
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
    chrome.storage.local.set({ [PANEL_COLLAPSED_KEY]: collapsed });
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

function applyLiveOnly() {
  if (!panelEl) return;
  const btn = panelEl.querySelector('.cc-fp-live-only');
  if (!btn) return;
  btn.classList.toggle('cc-active', liveOnly);
  btn.textContent = liveOnly ? '🔴 LIVE만' : '전체';
  btn.title = liveOnly ? '전체 보기로 전환' : '라이브만 보기';
}

function applyFavOnly() {
  if (!panelEl) return;
  const btn = panelEl.querySelector('.cc-fp-fav-only');
  if (!btn) return;
  btn.classList.toggle('cc-active', favOnly);
  btn.title = favOnly ? '전체 보기로 전환' : '즐겨찾기만 보기';
}

function applyOpacity() {
  if (!panelEl) return;
  panelEl.style.opacity = String(panelOpacity);
}

function applyIconized() {
  if (!panelEl) return;
  panelEl.style.display = panelIconized ? 'none' : '';
  const legacy = document.getElementById('cc-fp-icon');
  if (legacy) legacy.remove();
}

function enableIconDrag(btn) {
  let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0, moved = false;
  btn.addEventListener('mousedown', (e) => {
    const rect = btn.getBoundingClientRect();
    dragging = true; moved = false;
    sx = e.clientX; sy = e.clientY; ox = rect.left; oy = rect.top;
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
    const nx = Math.max(0, Math.min(window.innerWidth - btn.offsetWidth, ox + dx));
    const ny = Math.max(0, Math.min(window.innerHeight - btn.offsetHeight, oy + dy));
    btn.style.left = nx + 'px';
    btn.style.top = ny + 'px';
    btn.style.right = 'auto';
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    if (moved) {
      chrome.storage.local.set({ [ICON_POS_KEY]: { left: btn.style.left, top: btn.style.top } });
    }
  });
  btn.addEventListener('click', (e) => {
    if (moved) { e.preventDefault(); e.stopPropagation(); return; }
    const rect = btn.getBoundingClientRect();
    if (panelEl) {
      const pw = panelEl.offsetWidth || 280;
      const ph = panelEl.offsetHeight || 400;
      const left = Math.max(0, Math.min(window.innerWidth - pw, rect.left + rect.width / 2 - pw / 2));
      const top = Math.max(0, Math.min(window.innerHeight - 40, rect.top + rect.height / 2 - 20));
      panelEl.style.left = left + 'px';
      panelEl.style.top = top + 'px';
      panelEl.style.right = 'auto';
      panelEl.style.bottom = 'auto';
      chrome.storage.local.set({ [POS_KEY]: { left: panelEl.style.left, top: panelEl.style.top } });
    }
    panelIconized = false;
    chrome.storage.local.set({ [ICONIZED_KEY]: false });
    applyIconized();
  });
}

async function restoreIconPos(btn) {
  const { [ICON_POS_KEY]: pos } = await chrome.storage.local.get(ICON_POS_KEY);
  if (!pos) return;
  const left = parseInt(pos.left), top = parseInt(pos.top);
  if (!Number.isFinite(left) || !Number.isFinite(top)) return;
  if (left < 0 || top < 0 || left > window.innerWidth - 20 || top > window.innerHeight - 20) return;
  btn.style.left = pos.left;
  btn.style.top = pos.top;
  btn.style.right = 'auto';
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

// 팔로잉하지 않은 채널 검색 (디바운스 + 캐시)
const externalSearchCache = new Map(); // keyword -> { list, fetchedAt }
const EXTERNAL_SEARCH_TTL_MS = 60_000;
let externalSearchTimer = null;
let externalSearchSeq = 0;
async function fetchExternalChannels(keyword) {
  const cached = externalSearchCache.get(keyword);
  if (cached && Date.now() - cached.fetchedAt < EXTERNAL_SEARCH_TTL_MS) return cached.list;
  const url = `https://api.chzzk.naver.com/service/v1/search/channels?keyword=${encodeURIComponent(keyword)}&offset=0&size=20&withFirstChannelContent=false`;
  const r = await fetch(url, { credentials: 'include', cache: 'no-store' });
  if (!r.ok) throw new Error(`search ${r.status}`);
  const j = await r.json();
  const list = (j?.content?.data || []).map((d) => d.channel).filter(Boolean);
  externalSearchCache.set(keyword, { list, fetchedAt: Date.now() });
  return list;
}
function renderExternalSearchSection(body, keyword) {
  if (!keyword || keyword.length < 2) return;
  const myIds = new Set(cachedFollowings.map((f) => f.channelId));
  const sectionId = 'cc-ext-search';
  let section = body.querySelector('#' + sectionId);
  if (!section) {
    section = document.createElement('div');
    section.id = sectionId;
    section.className = 'cc-ext-search';
    section.style.cssText = 'margin-top:8px;border-top:1px dashed #444;padding-top:6px;';
    body.appendChild(section);
  }
  section.innerHTML = `<div style="font-size:11px;color:#888;padding:4px 8px;">🔎 팔로잉 외 채널 검색 중…</div>`;
  const mySeq = ++externalSearchSeq;
  clearTimeout(externalSearchTimer);
  externalSearchTimer = setTimeout(async () => {
    let list;
    try { list = await fetchExternalChannels(keyword); }
    catch (e) {
      if (mySeq !== externalSearchSeq) return;
      section.innerHTML = `<div style="font-size:11px;color:#e74c3c;padding:4px 8px;">검색 실패: ${escapeHtml(e.message)}</div>`;
      return;
    }
    if (mySeq !== externalSearchSeq) return;
    const others = list.filter((c) => !myIds.has(c.channelId));
    if (!others.length) {
      section.innerHTML = `<div style="font-size:11px;color:#888;padding:4px 8px;">🔎 팔로잉 외 채널: 결과 없음</div>`;
      return;
    }
    const rows = others.map((c) => {
      const fc = typeof c.followerCount === 'number' ? c.followerCount.toLocaleString() : '0';
      const liveDot = c.openLive ? '<span class="cc-live-dot" style="margin-right:4px;"></span>' : '';
      const img = c.channelImageUrl
        ? `<img src="${escapeHtml(c.channelImageUrl)}" onerror="this.style.display='none'">`
        : '<span class="cc-ch-noimg"></span>';
      return `
        <div class="cc-ch-row ${c.openLive ? 'cc-live' : ''}" data-cid="${escapeHtml(c.channelId)}" data-cname="${escapeHtml(c.channelName)}" title="${escapeHtml(c.channelName)}">
          <a class="cc-ch-link" href="https://chzzk.naver.com/${encodeURIComponent(c.channelId)}">
            ${img}
            <div class="cc-ch-text">
              <div class="cc-ch-line1">
                ${liveDot}<span class="cc-ch-name">${escapeHtml(c.channelName)}</span>
                <span class="cc-live-count" style="color:#888;">팔로워 ${escapeHtml(fc)}</span>
              </div>
            </div>
          </a>
        </div>
      `;
    }).join('');
    section.innerHTML = `<div style="font-size:11px;color:#888;padding:4px 8px;">🔎 팔로잉 외 채널 (${others.length})</div>${rows}`;
  }, 350);
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
    if (row) {
      e.dataTransfer.clearData();
      e.dataTransfer.setData('text/cc-channel', JSON.stringify({ cid: row.dataset.cid, fromGid: row.dataset.fromGid }));
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('cc-dragging');
      return;
    }
    const head = e.target.closest('.cc-group-head');
    if (head) {
      const groupEl = head.closest('.cc-group');
      const gid = groupEl?.dataset.gid;
      if (!gid || gid === OTHER_KEY) return;
      e.dataTransfer.clearData();
      e.dataTransfer.setData('text/cc-group', JSON.stringify({ gid }));
      e.dataTransfer.effectAllowed = 'move';
      groupEl.classList.add('cc-dragging');
    }
  });
  body.addEventListener('dragend', (e) => {
    body.querySelectorAll('.cc-dragging').forEach((el) => el.classList.remove('cc-dragging'));
    body.querySelectorAll('.cc-drop-target').forEach((el) => el.classList.remove('cc-drop-target'));
  });
  function clearDropIndicators() {
    body.querySelectorAll('.cc-drop-target,.cc-drop-above,.cc-drop-below').forEach((el) => el.classList.remove('cc-drop-target', 'cc-drop-above', 'cc-drop-below'));
  }
  function isGroupDrag(dt) {
    try { return dt.types && [...dt.types].includes('text/cc-group'); } catch (_) { return false; }
  }
  body.addEventListener('dragover', (e) => {
    const groupEl = e.target.closest('.cc-group[data-drop]');
    if (!groupEl) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearDropIndicators();
    if (isGroupDrag(e.dataTransfer) && groupEl.dataset.gid !== OTHER_KEY) {
      const head = groupEl.querySelector('.cc-group-head');
      const rect = head.getBoundingClientRect();
      const ratio = (e.clientY - rect.top) / rect.height;
      if (ratio < 0.3) groupEl.classList.add('cc-drop-above');
      else if (ratio > 0.7) groupEl.classList.add('cc-drop-below');
      else groupEl.classList.add('cc-drop-target');
    } else {
      groupEl.classList.add('cc-drop-target');
    }
  });
  body.addEventListener('dragleave', (e) => {
    const groupEl = e.target.closest('.cc-group[data-drop]');
    if (groupEl && !groupEl.contains(e.relatedTarget)) groupEl.classList.remove('cc-drop-target', 'cc-drop-above', 'cc-drop-below');
  });
  body.addEventListener('drop', async (e) => {
    e.preventDefault();
    body.querySelectorAll('.cc-drop-target').forEach((el) => el.classList.remove('cc-drop-target'));
    const groupEl = e.target.closest('.cc-group[data-drop]');
    const chData = e.dataTransfer.getData('text/cc-channel');
    const grpData = e.dataTransfer.getData('text/cc-group');
    if (chData) {
      if (!groupEl) return;
      const { cid, fromGid } = JSON.parse(chData);
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
      return;
    }
    if (grpData) {
      const { gid } = JSON.parse(grpData);
      const toGid = groupEl ? groupEl.dataset.gid : null;
      if (gid === toGid) return;
      const wantAbove = groupEl?.classList.contains('cc-drop-above');
      const wantBelow = groupEl?.classList.contains('cc-drop-below');
      const groups = await readGroups();
      const moving = groups.find((g) => g.id === gid);
      if (!moving) return;
      const descendants = new Set([gid]);
      let added = true;
      while (added) {
        added = false;
        for (const g of groups) {
          if (g.parentId && descendants.has(g.parentId) && !descendants.has(g.id)) { descendants.add(g.id); added = true; }
        }
      }
      if ((wantAbove || wantBelow) && toGid && toGid !== OTHER_KEY) {
        // 형제로 재정렬
        const target = groups.find((g) => g.id === toGid);
        if (!target) return;
        if (descendants.has(toGid)) return;
        moving.parentId = target.parentId || null;
        const siblings = groups.filter((g) => (g.parentId || null) === (target.parentId || null) && g.id !== gid);
        const ti = siblings.findIndex((g) => g.id === toGid);
        const insertAt = wantAbove ? ti : ti + 1;
        siblings.splice(insertAt, 0, moving);
        siblings.forEach((g, i) => { g.order = i; });
      } else {
        // 다른 그룹의 자식으로
        const newParent = (!toGid || toGid === OTHER_KEY) ? null : toGid;
        if (newParent && descendants.has(newParent)) return;
        if ((moving.parentId || null) === newParent) return;
        moving.parentId = newParent;
        const siblings = groups.filter((g) => (g.parentId || null) === newParent);
        siblings.forEach((g, i) => { g.order = i; });
      }
      await chrome.storage.local.set({ [GROUPS_KEY]: groups });
      refresh();
    }
  });
}

function enableDrag(panel, handle) {
  handle.style.cursor = 'move';
  let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
  handle.addEventListener('mousedown', (e) => {
    if (panelPinned) return;
    if (e.target.closest('button, select, input, textarea, a')) return;
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
  if (Number.isFinite(w) && w >= 220) panel.style.width = w + 'px';
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

// 예측 이벤트 + 도네이션 미션 상태 캐시
const predictionByCid = new Map();
const missionsByCid = new Map();
const PREDICTION_TTL_MS = 30000;
const MISSIONS_TTL_MS = 30000;
// ACTIVE: 진행중(참여 가능), EXPIRED: 참여 마감(결과 대기), COMPLETED: 결과 확인 완료
function predictionState(p) {
  if (!p || !p.status || !p.predictionId) return null;
  const s = String(p.status).toUpperCase();
  if (s === 'ACTIVE') return 'active';
  if (s === 'EXPIRED') return 'expired';
  return null; // COMPLETED 등은 표시 안 함
}
async function fetchPrediction(cid) {
  try {
    const r = await fetch(`https://api.chzzk.naver.com/service/v1/channels/${cid}/log-power/prediction`, { credentials: 'include', cache: 'no-store' });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.content || null;
  } catch (_) { return null; }
}
async function fetchMissions(cid) {
  try {
    const r = await fetch(`https://api.chzzk.naver.com/service/v2/channels/${cid}/donations/missions?filterStatus=APPROVED&filterStatus=EXPIRED&page=0&size=50`, { credentials: 'include', cache: 'no-store' });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.content?.data || [];
  } catch (_) { return null; }
}
async function refreshPredictionsForVisible() {
  const rows = document.querySelectorAll('#cc-followings-panel .cc-ch-row.cc-live');
  for (const row of rows) {
    const cid = row.dataset.cid;
    if (!cid) continue;
    // 예측
    const cachedP = predictionByCid.get(cid);
    if (cachedP && Date.now() - cachedP.fetchedAt < PREDICTION_TTL_MS) applyPredictionBadge(row, cachedP);
    else fetchPrediction(cid).then((p) => {
      const info = { ...(p || {}), fetchedAt: Date.now() };
      predictionByCid.set(cid, info);
      applyPredictionBadge(row, info);
    });
    // 미션
    const cachedM = missionsByCid.get(cid);
    if (cachedM && Date.now() - cachedM.fetchedAt < MISSIONS_TTL_MS) applyMissionLine(row, cachedM.list);
    else fetchMissions(cid).then((list) => {
      const info = { list: list || [], fetchedAt: Date.now() };
      missionsByCid.set(cid, info);
      applyMissionLine(row, info.list);
    });
  }
}
function fmtMoney(n) {
  if (!n) return '0';
  if (n >= 100000000) return (n / 100000000).toFixed(1) + '억';
  if (n >= 10000) return (n / 10000).toFixed(n >= 100000 ? 0 : 1) + '만';
  if (n >= 1000) return Math.floor(n / 1000) + '천';
  return String(n);
}
function applyMissionLine(row, list) {
  const text = row.querySelector('.cc-ch-text');
  if (!text) return;
  const existing = text.querySelector('.cc-mission-line');
  if (!list || !list.length) { if (existing) existing.remove(); return; }
  // APPROVED 우선, 없으면 EXPIRED
  const active = list.filter((m) => m.status === 'APPROVED');
  const items = active.length ? active : list;
  const first = items[0];
  const more = items.length - 1;
  const isActive = first.status === 'APPROVED';
  const label = isActive ? '미션 진행중' : '미션 마감';
  const color = isActive ? '#1AE192' : '#999';
  const parts = [first.missionText || '(제목 없음)'];
  if (first.totalAmount) parts.push(`${fmtMoney(first.totalAmount)}원`);
  if (first.participationCount) parts.push(`${first.participationCount}명`);
  const detail = parts.join(', ');
  const moreText = more > 0 ? ` 외 ${more}` : '';
  const svg = `<svg width="12" height="12" viewBox="0 0 32 32" fill="none" style="vertical-align:-2px;margin-right:3px;"><path d="M27.2 15.9998C27.2 22.1854 22.1856 27.1998 16 27.1998C9.8144 27.1998 4.79999 22.1854 4.79999 15.9998C4.79999 9.81422 9.8144 4.7998 16 4.7998" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M22.4 16.0001C22.4 19.5347 19.5346 22.4001 16 22.4001C12.4654 22.4001 9.59998 19.5347 9.59998 16.0001C9.59998 12.4655 12.4654 9.6001 16 9.6001" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M15.53 14.3737C15.0736 14.8542 15.093 15.6137 15.5735 16.0702C16.054 16.5267 16.8136 16.5072 17.27 16.0267L15.53 14.3737ZM17.27 16.0267L24.87 8.02669L23.13 6.3737L15.53 14.3737L17.27 16.0267Z" fill="currentColor"/><path d="M20.4938 5.99561L21.6959 9.60157C21.7437 9.74492 21.8561 9.8574 21.9995 9.90516L25.6043 11.1063C25.7768 11.1638 25.9669 11.1189 26.0955 10.9903L29.3212 7.76453C29.6009 7.48482 29.4412 7.00585 29.0496 6.94994L25.5564 6.45118C25.3452 6.42103 25.1793 6.25508 25.1491 6.04388L24.6501 2.55042C24.5941 2.15886 24.1152 1.9992 23.8355 2.27888L20.6098 5.50439C20.4812 5.63295 20.4363 5.82312 20.4938 5.99561Z" fill="currentColor"/></svg>`;
  const html = `<span style="color:${color};font-weight:600;">${svg}${label}</span> · <span style="color:#ccc;">${escapeHtml(detail)}${escapeHtml(moreText)}</span>`;
  if (existing) { existing.innerHTML = html; return; }
  const div = document.createElement('div');
  div.className = 'cc-mission-line';
  div.style.cssText = 'font-size:11px;line-height:1.3;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  div.innerHTML = html;
  text.appendChild(div);
}
function applyPredictionBadge(row, info) {
  const text = row.querySelector('.cc-ch-text');
  if (!text) return;
  const state = predictionState(info);
  const existing = text.querySelector('.cc-pred-line');
  if (!state) { if (existing) existing.remove(); return; }
  const meta = state === 'active'
    ? { label: '🪵 예측 진행중', color: '#c08866' }
    : { label: '🪵 참여 마감', color: '#c08866' };
  const title = info.predictionTitle || '';
  const html = `<span style="color:${meta.color};font-weight:600;">${meta.label}</span>${title ? ` · <span style="color:#ccc;">${escapeHtml(title)}</span>` : ''}`;
  if (existing) { existing.innerHTML = html; return; }
  const div = document.createElement('div');
  div.className = 'cc-pred-line';
  div.style.cssText = 'font-size:11px;line-height:1.3;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  div.innerHTML = html;
  text.appendChild(div);
}

function channelLink(c, gid) {
  const liveCountText = c.openLive && c.concurrentUserCount ? formatViewers(c.concurrentUserCount) : '';
  const wp = c.openLive ? watchParties.get(c.channelId) : null;
  const wpBadge = wp && wp.no ? `<span class="cc-wp-badge" title="같이보기${wp.tag ? ' · ' + wp.tag : ''}">🎬${wp.tag ? ' ' + escapeHtml(wp.tag) : ''}</span>` : '';
  const dropsBadge = wp && wp.drops ? `<span class="cc-drops-badge" title="드롭스 캠페인">🎁</span>` : '';
  const tooltip = c.openLive && c.liveTitle ? `${c.liveTitle}\n— ${c.channelName}` : c.channelName;
  const isNotify = notifyChannels.has(c.channelId);
  const isFav = favoriteChannels.has(c.channelId);
  const indicators = `${isFav ? '<span class="cc-ch-ind cc-ch-ind-fav" title="즐겨찾기">⚡</span>' : ''}${isNotify ? '<span class="cc-ch-ind cc-ch-ind-notify" title="알림">🔔</span>' : ''}`;
  const line2 = c.openLive ? `
    <div class="cc-ch-line2">
      <span class="cc-live-dot" title="LIVE"></span>
      ${wpBadge}${dropsBadge}
      <span class="cc-ch-title">${escapeHtml(c.liveTitle || '')}</span>
    </div>
  ` : '';
  return `
    <div class="cc-ch-row ${c.openLive ? 'cc-live' : ''}" data-cid="${escapeHtml(c.channelId)}" data-cname="${escapeHtml(c.channelName)}" data-from-gid="${escapeHtml(gid || '')}" draggable="true" title="${escapeHtml(tooltip)} · 우클릭: 메뉴">
      <a class="cc-ch-link" draggable="false" href="https://chzzk.naver.com/live/${encodeURIComponent(c.channelId)}">
        ${c.channelImageUrl ? `<img src="${escapeHtml(c.channelImageUrl)}" onerror="this.style.display='none'">` : '<span class="cc-ch-noimg"></span>'}
        <div class="cc-ch-text">
          <div class="cc-ch-line1">
            <span class="cc-ch-name">${escapeHtml(c.channelName)}</span>
            ${indicators}
            ${liveCountText ? `<span class="cc-live-count">${escapeHtml(liveCountText)}</span>` : ''}
          </div>
          ${line2}
        </div>
      </a>
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
  const sortByLiveThenName = (a, b) => (favoriteChannels.has(b.channelId) ? 1 : 0) - (favoriteChannels.has(a.channelId) ? 1 : 0) || (b.openLive ? 1 : 0) - (a.openLive ? 1 : 0) || (b.concurrentUserCount || 0) - (a.concurrentUserCount || 0) || a.channelName.localeCompare(b.channelName);
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

// nextPublishYmdt에서 publishPeriod(개월) 빼서 받은 추정일 계산 (선물은 보통 1개월)
function estimatedReceivedDate(nextPublishYmdt, publishPeriod) {
  if (!nextPublishYmdt) return '';
  const m = String(nextPublishYmdt).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  const months = Math.max(1, parseInt(publishPeriod) || 1);
  const d = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
  d.setMonth(d.getMonth() - months);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let cachedSubscriptions = null;
let subscriptionsFetchedAt = 0;
async function fetchSubscriptions(force) {
  if (!force && cachedSubscriptions && Date.now() - subscriptionsFetchedAt < 60000) return cachedSubscriptions;
  try {
    const r = await fetch('https://api.chzzk.naver.com/commercial/v1/subscribe/channels', { credentials: 'include', cache: 'no-store' });
    const j = await r.json();
    cachedSubscriptions = Array.isArray(j?.content) ? j.content : [];
    subscriptionsFetchedAt = Date.now();
  } catch (_) { cachedSubscriptions = cachedSubscriptions || []; }
  return cachedSubscriptions;
}

function renderSubscribe(followings) {
  const subs = cachedSubscriptions;
  if (!subs) {
    fetchSubscriptions().then(() => refresh());
    return '<div class="cc-empty">구독 목록 불러오는 중…</div>';
  }
  if (!subs.length) return '<div class="cc-empty">구독 중인 채널이 없습니다.</div>';
  const followingByCid = new Map(followings.map((f) => [f.channelId, f]));
  // 상태/만료일 순서: COMPLETE 먼저, 그 다음 만료일 임박 순
  const sorted = [...subs].sort((a, b) => {
    const sa = a.status === 'COMPLETE' ? 0 : 1;
    const sb = b.status === 'COMPLETE' ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return (a.nextPublishYmdt || '').localeCompare(b.nextPublishYmdt || '');
  });
  const rows = sorted.map((s) => {
    // 팔로잉 데이터에 있으면 라이브 상태 등 활용, 없으면 sub 정보로 채움
    const f = followingByCid.get(s.channelId) || {
      channelId: s.channelId,
      channelName: s.channelName,
      channelImageUrl: s.channelImageUrl,
      openLive: false,
      concurrentUserCount: 0,
      liveTitle: '',
    };
    const link = channelLink(f, null);
    // line1 끝부분에 구독 배지 추가
    const recvDate = s.isGift ? estimatedReceivedDate(s.nextPublishYmdt, s.publishPeriod) : '';
    const giftBadge = s.isGift ? `<span class="cc-ch-ind" title="선물 받은 추정일: ${recvDate}" style="background:#e0a93b;color:#111;padding:1px 5px;border-radius:3px;font-size:9px;font-weight:700;">🎁 ${recvDate.slice(5)}</span>` : '';
    const tierBadge = `<span class="cc-ch-ind" title="${escapeHtml(s.tierName || '')} · ${s.totalMonth}개월" style="background:rgba(26,225,146,0.15);color:#1AE192;padding:1px 5px;border-radius:3px;font-size:9px;font-weight:700;">⭐ ${s.totalMonth}개월</span>`;
    const cancelBadge = s.status === 'CANCEL' ? '<span class="cc-ch-ind" style="background:#444;color:#aaa;padding:1px 5px;border-radius:3px;font-size:9px;">해지예정</span>' : '';
    const badges = giftBadge + tierBadge + cancelBadge;
    // line1 마지막에 삽입 (</div> 직전)
    return link.replace(
      /(<div class="cc-ch-line1">[\s\S]*?)(<\/div>\s*(?:<div class="cc-ch-line2"|<\/div>))/,
      `$1${badges}$2`
    );
  }).join('');
  return rows;
}

function renderAddInput(parentId) {
  return `
    <div class="cc-group-add-input" data-parent="${escapeHtml(parentId || '')}">
      <input type="text" placeholder="그룹 이름..." maxlength="40">
      <button type="button" data-act="add-confirm">확인</button>
      <button type="button" data-act="add-cancel">취소</button>
    </div>
  `;
}

function renderWatchParty(followings) {
  const sortByLiveThenName = (a, b) => (favoriteChannels.has(b.channelId) ? 1 : 0) - (favoriteChannels.has(a.channelId) ? 1 : 0) || (b.concurrentUserCount || 0) - (a.concurrentUserCount || 0) || a.channelName.localeCompare(b.channelName);
  const live = followings.filter((f) => f.openLive && watchParties.get(f.channelId)?.no);
  if (!live.length) return '<div class="cc-empty">진행 중인 같이보기 채널이 없습니다.</div>';
  const byTag = new Map();
  for (const f of live) {
    const tag = watchParties.get(f.channelId)?.tag || '기타';
    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag).push(f);
  }
  const tags = [...byTag.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const colorFor = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return `hsl(${h % 360}, 60%, 55%)`; };
  return tags.map(([tag, list]) => {
    const id = 'wp:' + tag;
    const isCollapsed = collapsedGroups.has(id);
    list.sort(sortByLiveThenName);
    return `
      <div class="cc-group ${isCollapsed ? 'cc-group-collapsed' : ''}" data-gid="${escapeHtml(id)}">
        <div class="cc-group-head" style="--cc-c: ${colorFor(tag)}" data-act="toggle-group">
          <span class="cc-caret">${isCollapsed ? '▶' : '▼'}</span>
          <span class="cc-group-swatch"></span>
          <span class="cc-group-name">🎬 ${escapeHtml(tag)}</span>
          <span class="cc-group-count">${list.length}</span>
        </div>
        <div class="cc-group-body">${list.map((c) => channelLink(c, null)).join('')}</div>
      </div>
    `;
  }).join('');
}

function renderDrops(followings) {
  const sortByLiveThenName = (a, b) => (favoriteChannels.has(b.channelId) ? 1 : 0) - (favoriteChannels.has(a.channelId) ? 1 : 0) || (b.concurrentUserCount || 0) - (a.concurrentUserCount || 0) || a.channelName.localeCompare(b.channelName);
  const live = followings.filter((f) => f.openLive && watchParties.get(f.channelId)?.drops);
  if (!live.length) return '<div class="cc-empty">진행 중인 드롭스 캠페인이 없습니다.</div>';
  live.sort(sortByLiveThenName);
  return `<div class="cc-group" data-gid="drops:all">
    <div class="cc-group-head" style="--cc-c: #5b6cff" data-act="toggle-group">
      <span class="cc-caret">▼</span>
      <span class="cc-group-swatch"></span>
      <span class="cc-group-name">🎁 드롭스 진행 중</span>
      <span class="cc-group-count">${live.length}</span>
    </div>
    <div class="cc-group-body">${live.map((c) => channelLink(c, null)).join('')}</div>
  </div>`;
}

function renderByTag(followings) {
  const sortByLiveThenName = (a, b) => (favoriteChannels.has(b.channelId) ? 1 : 0) - (favoriteChannels.has(a.channelId) ? 1 : 0) || (b.concurrentUserCount || 0) - (a.concurrentUserCount || 0) || a.channelName.localeCompare(b.channelName);
  const live = followings.filter((f) => f.openLive && (liveTags.get(f.channelId)?.length || 0) > 0);
  if (!live.length) return '<div class="cc-empty">태그 정보가 있는 라이브 채널이 없습니다.</div>';
  const byTag = new Map();
  for (const f of live) {
    for (const t of (liveTags.get(f.channelId) || [])) {
      const key = t.trim().toLowerCase();
      if (!key) continue;
      if (!byTag.has(key)) byTag.set(key, { label: t, channels: [] });
      byTag.get(key).channels.push(f);
    }
  }
  const shared = [...byTag.entries()].filter(([_, v]) => v.channels.length >= 2)
    .sort((a, b) => b[1].channels.length - a[1].channels.length || a[1].label.localeCompare(b[1].label));
  if (!shared.length) return '<div class="cc-empty">공유되는 태그가 없습니다 (2개 이상 채널이 같은 태그를 가질 때 그룹화).</div>';
  const colorFor = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return `hsl(${h % 360}, 60%, 55%)`; };
  return shared.map(([key, info]) => {
    const id = 'tag:' + key;
    const isCollapsed = collapsedGroups.has(id);
    info.channels.sort(sortByLiveThenName);
    return `
      <div class="cc-group ${isCollapsed ? 'cc-group-collapsed' : ''}" data-gid="${escapeHtml(id)}">
        <div class="cc-group-head" style="--cc-c: ${colorFor(key)}" data-act="toggle-group">
          <span class="cc-caret">${isCollapsed ? '▶' : '▼'}</span>
          <span class="cc-group-swatch" style="background:${colorFor(key)}"></span>
          <span class="cc-group-name">#${escapeHtml(info.label)}</span>
          <span class="cc-group-count">${info.channels.length}</span>
        </div>
        <div class="cc-group-body">${info.channels.map((c) => channelLink(c, null)).join('')}</div>
      </div>
    `;
  }).join('');
}

function renderGrouped(groups, followings) {
  const byId = new Map(followings.map((f) => [f.channelId, f]));
  const assigned = new Set();
  for (const g of groups) for (const id of g.channelIds || []) assigned.add(id);

  const sortByLiveThenName = (a, b) => (favoriteChannels.has(b.channelId) ? 1 : 0) - (favoriteChannels.has(a.channelId) ? 1 : 0) || (b.openLive ? 1 : 0) - (a.openLive ? 1 : 0) || (b.concurrentUserCount || 0) - (a.concurrentUserCount || 0) || a.channelName.localeCompare(b.channelName);

  // 트리 구성
  const childrenMap = new Map(); // parentId -> Group[]
  for (const g of groups) {
    const p = g.parentId || null;
    if (!childrenMap.has(p)) childrenMap.set(p, []);
    childrenMap.get(p).push(g);
  }

  function descendantLiveCount(g) {
    const own = (g.channelIds || []).map((id) => byId.get(id)).filter((c) => c && c.openLive).length;
    const sub = (childrenMap.get(g.id) || []).reduce((s, c) => s + descendantLiveCount(c), 0);
    return own + sub;
  }
  function descendantTotalCount(g) {
    const own = (g.channelIds || []).filter((id) => byId.has(id)).length;
    const sub = (childrenMap.get(g.id) || []).reduce((s, c) => s + descendantTotalCount(c), 0);
    return own + sub;
  }

  function renderGroupNode(g, depth) {
    const channels = (g.channelIds || []).map((id) => byId.get(id)).filter(Boolean).sort(sortByLiveThenName);
    const children = (childrenMap.get(g.id) || []);
    const isCollapsed = collapsedGroups.has(g.id);
    const totalLive = descendantLiveCount(g);
    const totalAll = descendantTotalCount(g);
    const addForm = addingTo === g.id ? renderAddInput(g.id) : '';
    const inner =
      (channels.length ? channels.map((c) => channelLink(c, g.id)).join('') : (children.length || addForm ? '' : '<div class="cc-empty">채널 없음</div>'))
      + children.map((c) => renderGroupNode(c, depth + 1)).join('')
      + addForm;
    return `
      <div class="cc-group ${isCollapsed ? 'cc-group-collapsed' : ''}" data-gid="${escapeHtml(g.id)}" data-drop="1" style="margin-left:${depth * 12}px">
        <div class="cc-group-head" style="--cc-c: ${escapeHtml(g.color || '#1AE192')}" data-act="toggle-group" draggable="true">
          <span class="cc-caret">${isCollapsed ? '▶' : '▼'}</span>
          <input type="color" class="cc-group-swatch" data-act="change-color" data-id="${escapeHtml(g.id)}" value="${escapeHtml(g.color || '#1AE192')}" title="색상 변경" />
          <span class="cc-group-name">${escapeHtml(g.name)}</span>
          <span class="cc-group-count">${totalLive} / ${totalAll}</span>
          <button class="cc-group-add-child" type="button" data-act="add-child-group" data-id="${escapeHtml(g.id)}" title="하위 그룹 추가">+</button>
          <button class="cc-group-del" type="button" data-act="delete-group" data-id="${escapeHtml(g.id)}" title="그룹 삭제">×</button>
        </div>
        <div class="cc-group-body">${inner}</div>
      </div>
    `;
  }

  const sections = (childrenMap.get(null) || []).map((g) => renderGroupNode(g, 0));
  if (addingTo === 'root') sections.push(renderAddInput(null));

  const others = followings.filter((f) => !assigned.has(f.channelId)).sort(sortByLiveThenName);
  if (others.length) {
    const liveCount = others.filter((c) => c.openLive).length;
    const isCollapsed = collapsedGroups.has(OTHER_KEY);
    sections.push(`
      <div class="cc-group ${isCollapsed ? 'cc-group-collapsed' : ''}" data-gid="${escapeHtml(OTHER_KEY)}" data-drop="1">
        <div class="cc-group-head" style="--cc-c: #666" data-act="toggle-group">
          <span class="cc-caret">${isCollapsed ? '▶' : '▼'}</span>
          <span class="cc-group-swatch"></span>
          <span class="cc-group-name">기타</span>
          <span class="cc-group-count">${liveCount} / ${others.length}</span>
        </div>
        <div class="cc-group-body">${others.map((c) => channelLink(c, OTHER_KEY)).join('')}</div>
      </div>
    `);
  }

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
    const [groups, followings] = await Promise.all([readGroups(), fetchFollowings(), fetchFollowingLives()]);
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
  updateActiveTab(panel);
  const body = panel.querySelector('.cc-fp-body');
  const q = searchQuery.trim().toLowerCase();
  let filtered = cachedFollowings;
  if (favOnly) filtered = filtered.filter((f) => favoriteChannels.has(f.channelId));
  if (liveOnly) filtered = filtered.filter((f) => f.openLive);
  // 초성 검색: 쿼리가 한글 자음(ㄱ-ㅎ)만으로 구성되면 채널명/제목의 초성으로도 매칭
  const initialsQ = /^[ㄱ-ㅎ]+$/.test(q) ? q : null;
  if (q) filtered = filtered.filter((f) => {
    if (f.channelName.toLowerCase().includes(q)) return true;
    if ((f.liveTitle || '').toLowerCase().includes(q)) return true;
    if ((f.liveCategoryValue || '').toLowerCase().includes(q)) return true;
    if (initialsQ) {
      if (toInitials(f.channelName).includes(initialsQ)) return true;
      if (toInitials(f.liveTitle || '').includes(initialsQ)) return true;
    }
    const tags = liveTags.get(f.channelId) || [];
    if (tags.some((t) => (t || '').toLowerCase().includes(q))) return true;
    if (initialsQ && tags.some((t) => toInitials(t || '').includes(initialsQ))) return true;
    return false;
  });
  body.innerHTML = viewMode === 'bygame' ? renderByGame(filtered)
    : viewMode === 'subscribe' ? renderSubscribe(filtered)
    : viewMode === 'watchparty' ? renderWatchParty(filtered)
    : viewMode === 'drops' ? renderDrops(filtered)
    : viewMode === 'bytag' ? renderByTag(filtered)
    : renderGrouped(cachedGroups, filtered);
  // 라이브 채널들의 예측 이벤트 진행 여부 비동기 표시
  setTimeout(refreshPredictionsForVisible, 200);
  // 검색어 있을 때 팔로잉하지 않은 채널들 비동기 검색
  if (q) renderExternalSearchSection(body, searchQuery.trim());
  if (!body._ccScrollBound) {
    body._ccScrollBound = true;
    let scrollTimer = null;
    body.addEventListener('scroll', () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        sessionStorage.setItem(SCROLL_KEY, String(body.scrollTop));
      }, 150);
    });
  }
  const saved = parseInt(sessionStorage.getItem(SCROLL_KEY) || '0', 10);
  if (saved > 0) body.scrollTop = saved;
}

async function loadCollapsed() {
  const obj = await chrome.storage.local.get([COLLAPSED_KEY, VIEW_KEY, NOTIFY_KEY, PIN_KEY, LIVE_ONLY_KEY, FAV_KEY, FAV_ONLY_KEY, OPACITY_KEY, ICONIZED_KEY, PANEL_COLLAPSED_KEY]);
  const arr = obj[COLLAPSED_KEY];
  if (Array.isArray(arr)) for (const id of arr) collapsedGroups.add(id);
  else { collapsedGroups.add(OTHER_KEY); collapsedGroups.add(OFFLINE_KEY); }
  if (['custom', 'bygame', 'subscribe', 'watchparty', 'drops', 'bytag'].includes(obj[VIEW_KEY])) viewMode = obj[VIEW_KEY];
  if (Array.isArray(obj[NOTIFY_KEY])) notifyChannels = new Set(obj[NOTIFY_KEY]);
  if (obj[PIN_KEY] === true) panelPinned = true;
  if (obj[LIVE_ONLY_KEY] === true) liveOnly = true;
  if (Array.isArray(obj[FAV_KEY])) favoriteChannels = new Set(obj[FAV_KEY]);
  if (obj[FAV_ONLY_KEY] === true) favOnly = true;
  if (typeof obj[OPACITY_KEY] === 'number') panelOpacity = Math.max(0.2, Math.min(1, obj[OPACITY_KEY]));
  if (obj[ICONIZED_KEY] === true) panelIconized = true;
  if (obj[PANEL_COLLAPSED_KEY] === true) collapsed = true;
  if (panelEl) applyIconized();
}

function applyPanelCollapsed() {
  if (!panelEl) return;
  panelEl.classList.toggle('cc-collapsed', collapsed);
  const btn = panelEl.querySelector('.cc-fp-toggle');
  if (btn) btn.textContent = collapsed ? '+' : '−';
}

function saveCollapsed() {
  chrome.storage.local.set({ [COLLAPSED_KEY]: [...collapsedGroups] });
}

let defaultCollapseApplied = false;
function applyDefaultCollapse(groups) {
  if (defaultCollapseApplied) return;
  defaultCollapseApplied = true;
}

let ctxMenuEl = null;
function closeCtxMenu() { ctxMenuEl?.remove(); ctxMenuEl = null; }

function openChannelCtxMenu(x, y, cid, cname, fromGid) {
  closeCtxMenu();
  const isFav = favoriteChannels.has(cid);
  const isNotify = notifyChannels.has(cid);
  const inGroup = fromGid && fromGid !== OTHER_KEY;
  const items = [
    { act: 'fav-toggle', label: isFav ? '⚡ 즐겨찾기 해제' : '⚡ 즐겨찾기' },
    { act: 'notify-toggle', label: isNotify ? '🔔 알림 해제' : '🔕 알림 받기' },
    inGroup ? { act: 'remove-from-group', label: '↩ 이 그룹에서 제거', cls: 'cc-ctx-warn' } : null,
    { act: 'unfollow', label: '✕ 팔로우 취소', cls: 'cc-ctx-danger' },
  ].filter(Boolean);
  ctxMenuEl = document.createElement('div');
  ctxMenuEl.id = 'cc-ctx-menu';
  ctxMenuEl.innerHTML = items.map((it) => `<button data-act="${it.act}" class="${it.cls || ''}">${it.label}</button>`).join('');
  ctxMenuEl.style.left = x + 'px';
  ctxMenuEl.style.top = y + 'px';
  document.body.appendChild(ctxMenuEl);
  // viewport 보정
  const rect = ctxMenuEl.getBoundingClientRect();
  if (rect.right > window.innerWidth) ctxMenuEl.style.left = (window.innerWidth - rect.width - 8) + 'px';
  if (rect.bottom > window.innerHeight) ctxMenuEl.style.top = (window.innerHeight - rect.height - 8) + 'px';
  ctxMenuEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    closeCtxMenu();
    const act = btn.dataset.act;
    if (act === 'fav-toggle') {
      if (favoriteChannels.has(cid)) favoriteChannels.delete(cid); else favoriteChannels.add(cid);
      await chrome.storage.local.set({ [FAV_KEY]: [...favoriteChannels] });
      renderBody();
    } else if (act === 'notify-toggle') {
      const wasOn = notifyChannels.has(cid);
      if (wasOn) notifyChannels.delete(cid); else notifyChannels.add(cid);
      await chrome.storage.local.set({ [NOTIFY_KEY]: [...notifyChannels] });
      chrome.runtime.sendMessage({ type: wasOn ? 'clearState' : 'seedState', channelId: cid });
      renderBody();
    } else if (act === 'remove-from-group') {
      const groups = await readGroups();
      const g = groups.find((x) => x.id === fromGid);
      if (g) g.channelIds = (g.channelIds || []).filter((x) => x !== cid);
      await chrome.storage.local.set({ [GROUPS_KEY]: groups });
      refresh();
    } else if (act === 'unfollow') {
      if (!confirm(`"${cname}" 팔로우를 취소할까요?`)) return;
      try {
        await unfollowChannel(cid);
        const groups = await readGroups();
        for (const g of groups) g.channelIds = (g.channelIds || []).filter((x) => x !== cid);
        await chrome.storage.local.set({ [GROUPS_KEY]: groups });
        refresh();
      } catch (err) { alert('팔로우 취소 실패: ' + err.message); }
    }
  });
}
window.addEventListener('click', (e) => { if (!e.target.closest('#cc-ctx-menu')) closeCtxMenu(); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtxMenu(); });

async function commitAddGroup(formEl) {
  if (!formEl) return;
  const input = formEl.querySelector('input');
  const name = input?.value.trim();
  if (!name) { addingTo = null; renderBody(); return; }
  const parentId = formEl.dataset.parent || null;
  const groups = await readGroups();
  groups.push({ id: newGroupId(), name, color: '#1AE192', channelIds: [], order: groups.length, parentId });
  await chrome.storage.local.set({ [GROUPS_KEY]: groups });
  addingTo = null;
  refresh();
}

function bindGroupToggle(panel) {
  panel.querySelector('.cc-fp-body').addEventListener('change', async (e) => {
    const colorEl = e.target.closest('input[data-act="change-color"]');
    if (!colorEl) return;
    const id = colorEl.dataset.id;
    const newColor = colorEl.value;
    const groups = await readGroups();
    const g = groups.find((x) => x.id === id);
    if (g) g.color = newColor;
    await chrome.storage.local.set({ [GROUPS_KEY]: groups });
    refresh();
  });
  panel.querySelector('.cc-fp-body').addEventListener('keydown', async (e) => {
    if (!e.target.closest('.cc-group-add-input')) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      await commitAddGroup(e.target.closest('.cc-group-add-input'));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      addingTo = null; renderBody();
    }
  });
  panel.querySelector('.cc-fp-body').addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.cc-ch-row');
    if (!row) return;
    e.preventDefault();
    openChannelCtxMenu(e.clientX, e.clientY, row.dataset.cid, row.dataset.cname, row.dataset.fromGid);
  });
  panel.querySelector('.cc-fp-body').addEventListener('click', async (e) => {
    const favBtn = e.target.closest('[data-act="fav-toggle"]');
    if (favBtn) {
      e.preventDefault(); e.stopPropagation();
      const cid = favBtn.dataset.cid;
      if (favoriteChannels.has(cid)) favoriteChannels.delete(cid);
      else favoriteChannels.add(cid);
      await chrome.storage.local.set({ [FAV_KEY]: [...favoriteChannels] });
      renderBody();
      return;
    }
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
    const colorEl = e.target.closest('[data-act="change-color"]');
    if (colorEl) {
      // 클릭은 input이 받아 자체적으로 picker 열어주므로 toggle만 막음
      e.stopPropagation();
      return;
    }
    const addChildBtn = e.target.closest('[data-act="add-child-group"]');
    if (addChildBtn) {
      e.preventDefault(); e.stopPropagation();
      addingTo = addChildBtn.dataset.id;
      renderBody();
      setTimeout(() => panel.querySelector('.cc-group-add-input input')?.focus(), 0);
      return;
    }
    const addConfirm = e.target.closest('[data-act="add-confirm"]');
    if (addConfirm) {
      e.preventDefault(); e.stopPropagation();
      await commitAddGroup(addConfirm.closest('.cc-group-add-input'));
      return;
    }
    const addCancel = e.target.closest('[data-act="add-cancel"]');
    if (addCancel) {
      e.preventDefault(); e.stopPropagation();
      addingTo = null; renderBody();
      return;
    }
    const delGroupBtn = e.target.closest('[data-act="delete-group"]');
    if (delGroupBtn) {
      e.preventDefault(); e.stopPropagation();
      const id = delGroupBtn.dataset.id;
      if (!confirm('이 그룹을 삭제할까요? (하위 그룹은 한 단계 위로 이동)')) return;
      const groups = await readGroups();
      const target = groups.find((g) => g.id === id);
      const newParent = target?.parentId ?? null;
      const next = groups
        .filter((g) => g.id !== id)
        .map((g) => g.parentId === id ? { ...g, parentId: newParent } : g);
      await chrome.storage.local.set({ [GROUPS_KEY]: next });
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
  if (changes[FAV_KEY]) {
    favoriteChannels = new Set(Array.isArray(changes[FAV_KEY].newValue) ? changes[FAV_KEY].newValue : []);
    renderBody();
  }
  if (changes[OPACITY_KEY]) {
    const v = changes[OPACITY_KEY].newValue;
    if (typeof v === 'number') { panelOpacity = Math.max(0.2, Math.min(1, v)); applyOpacity(); }
  }
});

let featFollowingsEnabled = true;
function bootFollowings() {
  if (!featFollowingsEnabled) return;
  ensurePanel();
  ensureFloatingBtn();
  injectToolbarButton();
  syncFloatingBtn();
}

const tbObs = new MutationObserver(() => { bootFollowings(); });
if (document.documentElement) tbObs.observe(document.documentElement, { childList: true, subtree: true });
setInterval(bootFollowings, 2000);

chrome.storage.local.get('cc_feat_followings').then((o) => {
  featFollowingsEnabled = o.cc_feat_followings !== false;
  if (!featFollowingsEnabled) return;
  bootFollowings();
  loadCollapsed().then(refresh);
  window.addEventListener('resize', syncFloatingBtn);
  window.addEventListener('pageshow', () => {
    ensurePanel();
    injectToolbarButton();
    ensureFloatingBtn();
    syncFloatingBtn();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      ensurePanel();
      injectToolbarButton();
      ensureFloatingBtn();
      syncFloatingBtn();
    }
  });
});

function ensureFloatingBtn() {
  if (document.getElementById('cc-toolbar-btn-float')) return;
  const fb = document.createElement('button');
  fb.id = 'cc-toolbar-btn-float';
  fb.type = 'button';
  fb.title = '치지직 플러그인 패널 토글';
  fb.innerHTML = `<img src="${chrome.runtime.getURL('icons/icon48.png')}" width="22" height="22" style="display:block;border-radius:6px;">`;
  Object.assign(fb.style, {
    position: 'fixed', top: '12px', right: '12px', width: '34px', height: '34px',
    padding: '4px', display: 'none', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(30,30,36,0.85)', border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: '8px', cursor: 'pointer', zIndex: '999999',
    boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
  });
  fb.addEventListener('click', () => {
    ensurePanel();
    panelIconized = !panelIconized;
    chrome.storage.local.set({ [ICONIZED_KEY]: panelIconized });
    applyIconized();
  });
  document.body.appendChild(fb);
}

function syncFloatingBtn() {
  const fb = document.getElementById('cc-toolbar-btn-float');
  if (!fb) return;
  const headerBtn = document.getElementById('cc-toolbar-btn');
  const visible = headerBtn && headerBtn.offsetParent !== null && headerBtn.getBoundingClientRect().height > 0;
  fb.style.display = visible ? 'none' : 'flex';
}

function injectToolbarButton() {
  const studio = document.querySelector('[class*="toolbar_studio_button"]');
  if (!studio) return;
  const studioBox = studio.parentElement;
  if (!studioBox || studioBox.parentElement.querySelector('#cc-toolbar-btn')) return;
  const box = document.createElement('div');
  box.className = studioBox.className;
  const btn = document.createElement('button');
  btn.id = 'cc-toolbar-btn';
  btn.type = 'button';
  btn.className = studio.className;
  btn.title = '치지직 플러그인 패널 토글';
  const iconUrl = chrome.runtime.getURL('icons/icon48.png');
  btn.innerHTML = `<img src="${iconUrl}" width="20" height="20" style="vertical-align:middle;margin-right:6px;border-radius:4px;" alt="">플러그인`;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    ensurePanel();
    panelIconized = !panelIconized;
    chrome.storage.local.set({ [ICONIZED_KEY]: panelIconized });
    applyIconized();
  });
  box.appendChild(btn);
  studioBox.parentElement.insertBefore(box, studioBox);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'cc-live-toast' && msg.channel) showLiveToast(msg.channel);
  if (msg?.type === 'cc-gift-toast' && msg.gift) showGiftToast(msg.gift);
  if (msg?.type === 'cc-fetch-json-proxy' && msg.url) {
    fetch(msg.url, { credentials: 'include', cache: 'no-store' })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error('http ' + r.status)))
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ error: String(e.message ?? e) }));
    return true;
  }
});

let toastStackEl = null;
function ensureToastStack() {
  if (toastStackEl && document.body.contains(toastStackEl)) return toastStackEl;
  toastStackEl = document.createElement('div');
  toastStackEl.id = 'cc-toast-stack';
  document.body.appendChild(toastStackEl);
  return toastStackEl;
}

function showGiftToast(g) {
  const stack = ensureToastStack();
  const key = `gift:${g.channelId}:${g.nextPublishYmdt || ''}`;
  const existing = stack.querySelector(`[data-cid="${CSS.escape(key)}"]`);
  if (existing) return;
  const toast = document.createElement('div');
  toast.className = 'cc-toast';
  toast.dataset.cid = key;
  const exp = (g.nextPublishYmdt || '').slice(0, 10);
  const recv = estimatedReceivedDate(g.nextPublishYmdt, g.publishPeriod);
  toast.innerHTML = `
    ${g.channelImageUrl ? `<img class="cc-toast-img" src="${escapeHtml(g.channelImageUrl)}">` : ''}
    <div class="cc-toast-body">
      <div class="cc-toast-name">🎁 ${escapeHtml(g.channelName)} <span class="cc-toast-live" style="background:#e0a93b;">GIFT</span></div>
      <div class="cc-toast-title">${escapeHtml(g.tierName || g.tier || '')} 구독 선물 받음</div>
      ${recv ? `<div class="cc-toast-cat">받은 추정: ${escapeHtml(recv)} · 만료: ${escapeHtml(exp)}</div>` : (exp ? `<div class="cc-toast-cat">만료: ${escapeHtml(exp)}</div>` : '')}
      <div class="cc-toast-actions">
        <a class="cc-toast-go" href="https://chzzk.naver.com/${encodeURIComponent(g.channelId)}">채널 가기</a>
        <button class="cc-toast-close" type="button">닫기</button>
      </div>
    </div>
  `;
  stack.appendChild(toast);
  const close = () => { toast.classList.add('cc-toast-leaving'); setTimeout(() => toast.remove(), 1200); };
  toast.querySelector('.cc-toast-close').addEventListener('click', close);
  toast.querySelector('.cc-toast-go').addEventListener('click', close);
  const autoFadeTimer = setTimeout(close, 15000);
  toast.addEventListener('mouseenter', () => clearTimeout(autoFadeTimer));
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
  const close = () => { toast.classList.add('cc-toast-leaving'); setTimeout(() => toast.remove(), 1200); };
  toast.querySelector('.cc-toast-close').addEventListener('click', close);
  toast.querySelector('.cc-toast-go').addEventListener('click', close);
  const autoFadeTimer = setTimeout(close, 10000);
  toast.addEventListener('mouseenter', () => clearTimeout(autoFadeTimer));
}
