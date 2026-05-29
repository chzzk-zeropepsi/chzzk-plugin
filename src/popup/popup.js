import { readGroups, upsertGroup, deleteGroup, assignChannelToGroup, unassignChannel, newGroupId, readNotifyChannels, toggleNotifyChannel, readAllBookmarks, deleteBookmarkItem, updateBookmarkLabel, deleteBookmarkEntry } from '../lib/storage.js';
import { fetchFollowings } from '../lib/chzzk_api.js';

const $ = (id) => document.getElementById(id);

(async function initSync() {
  const SYNC_STATUS_KEY = 'cc_sync_status';
  const statusEl = $('syncStatus');
  function paintStatus(s) {
    if (!s) { statusEl.textContent = ''; return; }
    const color = s.kind === 'err' ? '#e74c3c' : s.kind === 'ok' ? '#1AE192' : s.kind === 'warn' ? '#e0a93b' : '#888';
    statusEl.style.color = color;
    statusEl.textContent = s.msg + (s.ts ? ` · ${new Date(s.ts).toLocaleTimeString()}` : '');
  }
  const saved = await chrome.storage.local.get(SYNC_STATUS_KEY);
  paintStatus(saved[SYNC_STATUS_KEY]);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[SYNC_STATUS_KEY]) paintStatus(changes[SYNC_STATUS_KEY].newValue);
  });
  chrome.runtime.sendMessage({ type: 'cc-sync-now' });
})();

(async function initFeatureToggles() {
  const keys = ['cc_feat_followings', 'cc_feat_vertical', 'cc_feat_bookmarks', 'cc_feat_downloads'];
  const noReloadKeys = new Set();
  const saved = await chrome.storage.local.get(keys);
  document.querySelectorAll('.feat-toggle').forEach((cb) => {
    const k = cb.dataset.key;
    // multi_record는 기본 OFF (명시적 opt-in), 나머지는 기본 ON
    cb.checked = saved[k] !== false;
    cb.addEventListener('change', async () => {
      await chrome.storage.local.set({ [k]: cb.checked });
      if (noReloadKeys.has(k)) return;
      const tabs = await chrome.tabs.query({ url: 'https://chzzk.naver.com/*' });
      tabs.forEach((t) => chrome.tabs.reload(t.id));
    });
  });
})();

document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    const name = t.dataset.tab;
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
  });
});

let followings = [];
let groups = [];
let expandedGroupId = null;
const pickerQuery = new Map();

function showErr(msg) {
  const el = $('groupsErr');
  el.hidden = !msg;
  el.textContent = msg || '';
}

let notifyChannels = new Set();
let notifySearchQuery = '';
let notifyOnlySelected = false;

async function loadAll() {
  showErr('');
  try {
    followings = await fetchFollowings();
  } catch (e) {
    showErr('팔로잉 목록 로드 실패 (치지직 로그인 필요): ' + e.message);
    followings = [];
  }
  groups = await readGroups();
  notifyChannels = new Set(await readNotifyChannels());
  render();
  renderNotify();
}

function renderNotify() {
  const list = $('notifyList');
  if (!list) return;
  const q = notifySearchQuery.trim().toLowerCase();
  let source = followings.slice().sort((a, b) => a.channelName.localeCompare(b.channelName));
  if (notifyOnlySelected) source = source.filter((f) => notifyChannels.has(f.channelId));
  if (q) source = source.filter((f) => f.channelName.toLowerCase().includes(q));
  if (!source.length) { list.innerHTML = '<div class="empty">결과 없음</div>'; return; }
  list.innerHTML = source.map((f) => `
    <div class="ch-pick-row" data-act="notify-toggle" data-cid="${escapeHtml(f.channelId)}">
      ${f.channelImageUrl ? `<img src="${escapeHtml(f.channelImageUrl)}">` : ''}
      <span style="flex:1">${escapeHtml(f.channelName)}</span>
      ${f.openLive ? '<span class="live-dot" title="LIVE"></span>' : ''}
      <input type="checkbox" ${notifyChannels.has(f.channelId) ? 'checked' : ''} style="width:auto;pointer-events:none;">
    </div>
  `).join('');
}

document.addEventListener('click', async (e) => {
  const row = e.target.closest('[data-act="notify-toggle"]');
  if (!row) return;
  const cid = row.dataset.cid;
  const wasOn = notifyChannels.has(cid);
  const list = await toggleNotifyChannel(cid);
  notifyChannels = new Set(list);
  renderNotify();
  if (!wasOn) chrome.runtime.sendMessage({ type: 'seedState', channelId: cid });
  else chrome.runtime.sendMessage({ type: 'clearState', channelId: cid });
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'notifySearch') { notifySearchQuery = e.target.value; renderNotify(); }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'notifyOnlySelected') { notifyOnlySelected = e.target.checked; renderNotify(); }
});

function chById(channelId) {
  return followings.find((f) => f.channelId === channelId) || { channelId, channelName: channelId, channelImageUrl: '' };
}

function assignedChannelIds() {
  const s = new Set();
  for (const g of groups) for (const c of g.channelIds || []) s.add(c);
  return s;
}

function render() {
  const root = $('groupsList');
  root.innerHTML = '';
  if (!groups.length) {
    root.innerHTML = '<div class="empty">아직 그룹이 없습니다. 아래에서 추가하세요.</div>';
  }
  const childrenMap = new Map();
  for (const g of groups) {
    const p = g.parentId || null;
    if (!childrenMap.has(p)) childrenMap.set(p, []);
    childrenMap.get(p).push(g);
  }
  function renderNode(g, depth) {
    const row = document.createElement('div');
    row.className = 'group-row';
    row.style.marginLeft = (depth * 14) + 'px';
    row.innerHTML = `
      <span class="swatch" style="background:${g.color || '#1AE192'}"></span>
      <span class="name">${escapeHtml(g.name)}</span>
      <span class="count">${(g.channelIds || []).length}개</span>
      <button class="secondary" data-act="rename" data-id="${g.id}">이름</button>
      <button class="secondary" data-act="add-child" data-id="${g.id}" title="하위 그룹 추가">+ 하위</button>
      <button class="secondary" data-act="toggle" data-id="${g.id}">${expandedGroupId === g.id ? '닫기' : '편집'}</button>
      <button class="secondary" data-act="delete" data-id="${g.id}">삭제</button>
    `;
    root.appendChild(row);
    if (expandedGroupId === g.id) root.appendChild(renderGroupDetail(g));
    for (const child of (childrenMap.get(g.id) || [])) renderNode(child, depth + 1);
  }
  for (const g of (childrenMap.get(null) || [])) renderNode(g, 0);
}

function renderGroupDetail(g) {
  const wrap = document.createElement('div');
  wrap.className = 'group-detail';
  const assigned = (g.channelIds || []).map(chById);
  const assignedSet = new Set(g.channelIds || []);
  const q = (pickerQuery.get(g.id) || '').trim().toLowerCase();
  const baseCandidates = followings.filter((f) => !assignedChannelIds().has(f.channelId) || assignedSet.has(f.channelId));
  const candidates = q ? baseCandidates.filter((f) => f.channelName.toLowerCase().includes(q)) : baseCandidates;
  wrap.innerHTML = `
    <h3>${escapeHtml(g.name)} 채널</h3>
    <div class="pills">
      ${assigned.length ? assigned.map((c) => `
        <span class="ch-pill">
          ${c.channelImageUrl ? `<img src="${escapeHtml(c.channelImageUrl)}" onerror="this.style.display='none'">` : ''}
          ${escapeHtml(c.channelName)}
          <button data-act="unassign" data-cid="${escapeHtml(c.channelId)}">×</button>
        </span>
      `).join('') : '<div class="empty">채널 없음. 아래에서 추가</div>'}
    </div>
    <div style="margin-top:8px;display:flex;align-items:center;gap:6px;">
      <span style="font-size:11px;color:#888;flex-shrink:0;">추가할 채널:</span>
      <input class="ch-search" data-gid="${escapeHtml(g.id)}" placeholder="채널명 검색" value="${escapeHtml(q)}" style="flex:1;">
    </div>
    <div class="ch-picker">
      ${candidates.map((f) => `
        <div class="ch-pick-row" data-act="assign" data-cid="${escapeHtml(f.channelId)}">
          ${f.channelImageUrl ? `<img src="${escapeHtml(f.channelImageUrl)}">` : ''}
          <span style="flex:1">${escapeHtml(f.channelName)}</span>
          ${f.openLive ? '<span class="live-dot" title="LIVE"></span>' : ''}
          ${assignedSet.has(f.channelId) ? '<span style="font-size:10px;color:#1AE192">✓</span>' : ''}
        </div>
      `).join('') || `<div class="empty">${q ? '검색 결과 없음' : '팔로잉 채널 없음'}</div>`}
    </div>
  `;
  const searchInput = wrap.querySelector('.ch-search');
  const pickerEl = wrap.querySelector('.ch-picker');
  const updatePicker = () => {
    const qq = (pickerQuery.get(g.id) || '').trim().toLowerCase();
    const list = qq ? baseCandidates.filter((f) => f.channelName.toLowerCase().includes(qq)) : baseCandidates;
    pickerEl.innerHTML = list.map((f) => `
      <div class="ch-pick-row" data-act="assign" data-cid="${escapeHtml(f.channelId)}">
        ${f.channelImageUrl ? `<img src="${escapeHtml(f.channelImageUrl)}">` : ''}
        <span style="flex:1">${escapeHtml(f.channelName)}</span>
        ${f.openLive ? '<span class="live-dot" title="LIVE"></span>' : ''}
        ${assignedSet.has(f.channelId) ? '<span style="font-size:10px;color:#1AE192">✓</span>' : ''}
      </div>
    `).join('') || `<div class="empty">${qq ? '검색 결과 없음' : '팔로잉 채널 없음'}</div>`;
  };
  searchInput.addEventListener('input', (e) => {
    pickerQuery.set(g.id, e.target.value);
    updatePicker();
  });
  return wrap;
}

$('groupsList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const id = btn.dataset.id;
  const cid = btn.dataset.cid;
  if (act === 'delete') {
    if (!confirm('이 그룹을 삭제할까요?')) return;
    groups = await deleteGroup(id);
    if (expandedGroupId === id) expandedGroupId = null;
    render();
  } else if (act === 'rename') {
    const g = groups.find((x) => x.id === id);
    const name = prompt('새 이름:', g.name);
    if (!name) return;
    groups = await upsertGroup({ ...g, name: name.trim() });
    render();
  } else if (act === 'add-child') {
    const name = prompt('하위 그룹 이름:');
    if (!name?.trim()) return;
    groups = await upsertGroup({ id: newGroupId(), name: name.trim(), color: '#1AE192', parentId: id });
    render();
  } else if (act === 'toggle') {
    expandedGroupId = expandedGroupId === id ? null : id;
    render();
  } else if (act === 'assign') {
    groups = await assignChannelToGroup(expandedGroupId, cid);
    render();
  } else if (act === 'unassign') {
    groups = await unassignChannel(cid);
    render();
  }
});

$('addGroupBtn').addEventListener('click', async () => {
  const name = $('newGroupName').value.trim();
  if (!name) return;
  const color = $('newGroupColor').value || '#1AE192';
  groups = await upsertGroup({ id: newGroupId(), name, color, parentId: null });
  $('newGroupName').value = '';
  render();
});

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTime(s) {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

function fmtDate(s) {
  if (!s) return '';
  const t = Date.parse(s.includes('T') ? s : s.replace(' ', 'T') + '+09:00');
  if (!Number.isFinite(t)) return s;
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

async function renderBookmarks() {
  const root = $('bookmarkList');
  if (!root) return;
  const all = await readAllBookmarks();
  const entries = Object.entries(all).sort((a, b) => (b[1].openDate || '').localeCompare(a[1].openDate || ''));
  if (!entries.length) { root.innerHTML = '<div class="empty">저장된 북마크 없음. 라이브 방송 중 패널의 🔖 북마크 버튼으로 추가하세요.</div>'; return; }
  root.innerHTML = entries.map(([liveId, entry]) => `
    <div class="bm-entry" data-lid="${escapeHtml(liveId)}">
      <div class="bm-head">
        <div class="bm-head-main">
          <div class="bm-channel">${escapeHtml(entry.channelName || '(이름 없음)')}</div>
          <div class="bm-title">${escapeHtml(entry.liveTitle || '')}</div>
          <div class="bm-date">${escapeHtml(fmtDate(entry.openDate))}</div>
        </div>
        <button class="bm-del-all secondary" data-act="bm-del-entry" data-lid="${escapeHtml(liveId)}" title="이 방송의 북마크 전체 삭제">전체 삭제</button>
      </div>
      <div class="bm-items">
        ${(entry.items || []).map((item) => `
          <div class="bm-item" data-at="${item.createdAt}">
            <span class="bm-time">${fmtTime(item.at)}</span>
            <span class="bm-label" contenteditable="true" data-act="bm-label" data-lid="${escapeHtml(liveId)}" data-at="${item.createdAt}">${escapeHtml(item.label || '(라벨 없음)')}</span>
            <button class="bm-del" data-act="bm-del-item" data-lid="${escapeHtml(liveId)}" data-at="${item.createdAt}" title="삭제">×</button>
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');
}

document.addEventListener('click', async (e) => {
  const delItem = e.target.closest('[data-act="bm-del-item"]');
  if (delItem) {
    await deleteBookmarkItem(delItem.dataset.lid, Number(delItem.dataset.at));
    renderBookmarks();
    return;
  }
  const delEntry = e.target.closest('[data-act="bm-del-entry"]');
  if (delEntry) {
    if (!confirm('이 방송의 모든 북마크를 삭제할까요?')) return;
    await deleteBookmarkEntry(delEntry.dataset.lid);
    renderBookmarks();
  }
});

document.addEventListener('blur', async (e) => {
  if (!e.target.matches?.('[data-act="bm-label"]')) return;
  const el = e.target;
  const text = el.textContent.trim();
  await updateBookmarkLabel(el.dataset.lid, Number(el.dataset.at), text === '(라벨 없음)' ? '' : text);
}, true);

document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => { if (t.dataset.tab === 'bookmarks') renderBookmarks(); });
});

async function initOpacity() {
  const slider = $('opacitySlider');
  const label = $('opacityValue');
  if (!slider) return;
  const { cc_panel_opacity } = await chrome.storage.local.get('cc_panel_opacity');
  const v = typeof cc_panel_opacity === 'number' ? Math.round(cc_panel_opacity * 100) : 97;
  slider.value = v;
  label.textContent = v + '%';
  slider.addEventListener('input', () => {
    label.textContent = slider.value + '%';
    chrome.storage.local.set({ cc_panel_opacity: parseInt(slider.value) / 100 });
  });
}

loadAll();
renderBookmarks();
initOpacity();
