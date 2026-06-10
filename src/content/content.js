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
let skipNextGroupsRefresh = false; // 부분 갱신 후 자기 자신의 storage.onChanged 무시

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

// ===== 매니저용: 채팅 누적 + 키워드 검색 =====
const CHAT_BUFFER_MAX = 5000;
const chatBufferByCid = new Map(); // cid -> [{ts, uid, nickname, role, msg}]
const managerRoleByCid = new Map(); // cid -> bool (캐시, 1시간)
const MANAGER_TTL_MS = 60 * 60 * 1000;
function parseChatProfile(item) {
  try { return JSON.parse(item.profile || '{}'); } catch (_) { return {}; }
}
function parseChatExtras(item) {
  try { return JSON.parse(item.extras || '{}'); } catch (_) { return {}; }
}
// 기본/치트키/구독 이모지 카탈로그 (cid별, 1시간 캐시)
const emojiCatalogByCid = new Map();
const EMOJI_CATALOG_TTL_MS = 60 * 60 * 1000;
async function fetchEmojiCatalog(cid) {
  if (!cid) return null;
  const cached = emojiCatalogByCid.get(cid);
  if (cached && Date.now() - cached.fetchedAt < EMOJI_CATALOG_TTL_MS) return cached.map;
  try {
    const r = await fetch(`https://api.chzzk.naver.com/service/v1/channels/${encodeURIComponent(cid)}/emoji-packs`, { credentials: 'include', cache: 'no-store' });
    if (!r.ok) return null;
    const j = await r.json();
    const c = j?.content || {};
    const map = {};
    const collect = (packs) => {
      if (!Array.isArray(packs)) return;
      for (const pack of packs) {
        for (const e of pack.emojis || []) if (e.emojiId && e.imageUrl) map[e.emojiId] = e.imageUrl;
        for (const e of pack.tier1Emojis || []) if (e.emojiId && e.imageUrl) map[e.emojiId] = e.imageUrl;
        for (const e of pack.tier2Emojis || []) if (e.emojiId && e.imageUrl) map[e.emojiId] = e.imageUrl;
      }
    };
    collect(c.emojiPacks);
    collect(c.cheatKeyEmojiPacks);
    collect(c.subscriptionEmojiPacks);
    emojiCatalogByCid.set(cid, { map, fetchedAt: Date.now() });
    return map;
  } catch (_) { return null; }
}
function resolveEmojiUrl(key, msgEmojis, catalog) {
  const ent = msgEmojis?.[key];
  if (ent) return typeof ent === 'string' ? ent : (ent.imageUrl || ent.url);
  return catalog?.[key] || null;
}
function renderMsgHtml(msg, msgEmojis, catalog) {
  const text = String(msg || '');
  const parts = [];
  const re = /\{:([^:}\s]+):\}/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ t: 'text', v: text.slice(last, m.index) });
    const url = resolveEmojiUrl(m[1], msgEmojis, catalog);
    parts.push(url ? { t: 'img', url, key: m[1] } : { t: 'text', v: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ t: 'text', v: text.slice(last) });
  return parts.map((p) => p.t === 'img'
    ? `<img src="${escapeHtml(p.url)}" alt="${escapeHtml(p.key)}" title="${escapeHtml(p.key)}" style="height:1.4em;vertical-align:middle;">`
    : escapeHtml(p.v)
  ).join('');
}
const chatSeenByCid = new Map(); // cid -> Map<key, ts>
const SOFT_DEDUPE_MS = 15000;
function chatDedupeKey(uid, msg) { return `${uid}|${msg}`; }
window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.source !== 'cc-chat-incoming') return;
  const { cid, item } = e.data;
  if (!cid || !item) return;
  const prof = parseChatProfile(item);
  const uid = item.uid ?? item.userId ?? prof.userIdHash ?? '';
  const role = prof.userRoleCode || '';
  const msg = item.msg ?? item.content ?? item.message ?? '';
  const ts = item.msgTime ?? item.messageTime ?? item.createTime ?? Date.now();
  if (!uid || !msg) return;
  const key = chatDedupeKey(uid, msg);
  let seen = chatSeenByCid.get(cid);
  if (!seen) { seen = new Map(); chatSeenByCid.set(cid, seen); }
  const last = seen.get(key);
  if (last && Date.now() - last < SOFT_DEDUPE_MS) return;
  seen.set(key, Date.now());
  if (seen.size > CHAT_BUFFER_MAX * 2) {
    const arr = [...seen.entries()].sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < arr.length - CHAT_BUFFER_MAX; i++) seen.delete(arr[i][0]);
  }
  const nickname = prof.nickname || (myUserIdHash && uid === myUserIdHash ? myNickname : '');
  const extras = parseChatExtras(item);
  const emojis = extras.emojis && typeof extras.emojis === 'object' ? extras.emojis : null;
  const entry = { ts, uid, nickname, role, msg, emojis };
  const buf = chatBufferByCid.get(cid) || [];
  buf.push(entry);
  if (buf.length > CHAT_BUFFER_MAX) buf.splice(0, buf.length - CHAT_BUFFER_MAX);
  // 시간순 정렬 보장 (히스토리는 한꺼번에 와서 시간 역순일 수 있음)
  buf.sort((a, b) => a.ts - b.ts);
  chatBufferByCid.set(cid, buf);
  queueDbChatWrite({ cid, ...entry });
  if (chatSearchEl) chatSearchEl._onIncoming?.();
  if (uid && MOD_ROLES.has(role) && myUserIdHash && uid === myUserIdHash) {
    const prev = managerRoleByCid.get(cid);
    if (!prev?.value) {
      managerRoleByCid.set(cid, { ts: Date.now(), value: true });
      ensureChatSearchButton();
    }
  }
});
let myUserIdHash = null;
let myNickname = '';
async function getMyUserIdHash() {
  if (myUserIdHash !== null) return myUserIdHash;
  try {
    const r = await fetch('https://comm-api.game.naver.com/nng_main/v1/user/getUserStatus', { credentials: 'include', cache: 'no-store' });
    if (!r.ok) return null;
    const j = await r.json();
    myUserIdHash = j?.content?.userIdHash || j?.content?.hashId || null;
    myNickname = j?.content?.nickname || j?.content?.userName || '';
  } catch (_) {}
  return myUserIdHash;
}
const MOD_ROLES = new Set(['streamer', 'streaming_channel_manager', 'streaming_chat_manager']);
async function checkManagerRole(cid) {
  if (!cid) return false;
  const cached = managerRoleByCid.get(cid);
  if (cached && Date.now() - cached.ts < MANAGER_TTL_MS) return cached.value;
  // 스트리머 본인: cid가 내 userIdHash와 동일 (chzzk 구조상 채널ID = 스트리머hash)
  const myHash = await getMyUserIdHash();
  if (myHash && cid === myHash) {
    managerRoleByCid.set(cid, { ts: Date.now(), value: true });
    return true;
  }
  let value = false;
  // 위임받은 매니저: /manage/v1/channels 200
  try {
    const r = await fetch(`https://api.chzzk.naver.com/manage/v1/channels/${encodeURIComponent(cid)}`, { credentials: 'include', cache: 'no-store' });
    value = r.ok;
  } catch (_) {}
  managerRoleByCid.set(cid, { ts: Date.now(), value });
  return value;
}
function currentLiveCid() {
  const m = location.pathname.match(/^\/live\/([^/?#]+)/);
  return m ? m[1] : null;
}
// IndexedDB로 채팅 영속화
let chatDbPromise = null;
function chatDB() {
  if (chatDbPromise) return chatDbPromise;
  chatDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open('ccChatDB', 2);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      let store;
      if (e.oldVersion < 1) {
        store = db.createObjectStore('messages', { autoIncrement: true });
        store.createIndex('cid_ts', ['cid', 'ts']);
      } else {
        store = req.transaction.objectStore('messages');
      }
      if (!store.indexNames.contains('ts')) store.createIndex('ts', 'ts');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return chatDbPromise;
}
// 채팅 기록 설정 (popup에서 변경)
let chatLogEnabled = true;
let chatRetentionDays = 1;
chrome.storage.local.get(['cc_chat_log_enabled', 'cc_chat_retention_days']).then((obj) => {
  chatLogEnabled = obj.cc_chat_log_enabled !== false;
  if (obj.cc_chat_retention_days) chatRetentionDays = obj.cc_chat_retention_days;
}).catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('cc_chat_log_enabled' in changes) chatLogEnabled = changes.cc_chat_log_enabled.newValue !== false;
  if ('cc_chat_retention_days' in changes) chatRetentionDays = changes.cc_chat_retention_days.newValue || 1;
});
// 보존기간 지난 채팅 자동 삭제 (세션당 1회)
let chatPruned = false;
async function pruneOldChats() {
  if (chatPruned) return;
  chatPruned = true;
  try {
    const db = await chatDB();
    const cutoff = Date.now() - chatRetentionDays * 24 * 60 * 60 * 1000;
    const tx = db.transaction('messages', 'readwrite');
    const idx = tx.objectStore('messages').index('ts');
    idx.openCursor(IDBKeyRange.upperBound(cutoff)).onsuccess = (e) => {
      const cur = e.target.result;
      if (!cur) return;
      cur.delete();
      cur.continue();
    };
  } catch (_) {}
}
async function dbClearAllChats() {
  const db = await chatDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('messages', 'readwrite');
    tx.objectStore('messages').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg?.type === 'cc-chat-clear-all') {
    dbClearAllChats().then(() => {
      chatBufferByCid.clear();
      chatSeenByCid.clear();
      sendResponse({ ok: true });
    }).catch((e) => sendResponse({ error: String(e?.message || e) }));
    return true;
  }
  return false;
});
const dbWriteQueue = [];
let dbWriteTimer = null;
function queueDbChatWrite(entry) {
  if (!chatLogEnabled) return;
  pruneOldChats();
  dbWriteQueue.push(entry);
  if (dbWriteTimer) return;
  dbWriteTimer = setTimeout(async () => {
    const batch = dbWriteQueue.splice(0);
    dbWriteTimer = null;
    try {
      const db = await chatDB();
      const tx = db.transaction('messages', 'readwrite');
      const store = tx.objectStore('messages');
      for (const e of batch) store.add(e);
    } catch (_) {}
  }, 500);
}
async function dbGetChats(cid, limit = 5000) {
  pruneOldChats();
  const db = await chatDB();
  return new Promise((resolve, reject) => {
    const out = [];
    const tx = db.transaction('messages', 'readonly');
    const idx = tx.objectStore('messages').index('cid_ts');
    const range = IDBKeyRange.bound([cid, 0], [cid, Number.MAX_SAFE_INTEGER]);
    const req = idx.openCursor(range, 'prev');
    req.onsuccess = (e) => {
      const cur = e.target.result;
      if (!cur || out.length >= limit) { out.reverse(); resolve(out); return; }
      out.push(cur.value);
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
}
async function dbDeleteChats(cid) {
  const db = await chatDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('messages', 'readwrite');
    const idx = tx.objectStore('messages').index('cid_ts');
    const range = IDBKeyRange.bound([cid, 0], [cid, Number.MAX_SAFE_INTEGER]);
    idx.openCursor(range).onsuccess = (e) => {
      const cur = e.target.result;
      if (!cur) return;
      cur.delete();
      cur.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function getChannelName(cid) {
  if (!cid) return '';
  const cached = cachedFollowings.find((f) => f.channelId === cid);
  if (cached?.channelName) return cached.channelName;
  try {
    const r = await fetch(`https://api.chzzk.naver.com/service/v1/channels/${encodeURIComponent(cid)}`, { credentials: 'include', cache: 'no-store' });
    if (!r.ok) return '';
    const j = await r.json();
    return j?.content?.channelName || '';
  } catch (_) { return ''; }
}
let chatSearchEl = null;
function openChatSearchPanel(cid) {
  if (chatSearchEl) { chatSearchEl.remove(); chatSearchEl = null; }
  chatSearchEl = document.createElement('div');
  chatSearchEl.id = 'cc-chat-search';
  chatSearchEl.style.cssText = 'position:fixed;top:80px;right:16px;width:380px;max-height:70vh;background:rgba(20,20,24,0.97);color:#eee;border:2px solid #749FFE;border-radius:10px;box-shadow:0 4px 20px rgba(116,159,254,0.3);z-index:2147483646;font:13px/1.4 -apple-system,sans-serif;display:flex;flex-direction:column;';
  chatSearchEl.innerHTML = `
    <div style="display:flex;align-items:center;gap:6px;padding:10px 12px;background:#749FFE;color:#111;font-weight:700;">
      <span>🔍 채팅 검색</span>
      <span style="margin-left:auto;opacity:.8;font-size:11px;" id="cc-chat-count">0건</span>
      <button id="cc-chat-close" style="background:transparent;border:none;color:#111;font-size:16px;cursor:pointer;">×</button>
    </div>
    <div style="display:flex;gap:4px;padding:6px 10px 0;align-items:center;font-size:11px;">
      <button id="cc-chat-clear" style="background:#2a2a32;border:1px solid #444;color:#e74c3c;border-radius:4px;padding:3px 8px;cursor:pointer;">🗑 이 채널 기록 삭제</button>
      <span id="cc-chat-mode" style="margin-left:auto;color:#888;">로딩 중…</span>
    </div>
    <input id="cc-chat-q" type="text" placeholder="키워드 또는 닉네임…" style="margin:8px 10px;padding:6px 8px;background:#1a1a1f;border:1px solid #333;border-radius:4px;color:#eee;">
    <div id="cc-chat-results" style="flex:1;overflow:auto;padding:0 10px 10px;"></div>
  `;
  document.body.appendChild(chatSearchEl);
  const input = chatSearchEl.querySelector('#cc-chat-q');
  const out = chatSearchEl.querySelector('#cc-chat-results');
  const cnt = chatSearchEl.querySelector('#cc-chat-count');
  chatSearchEl.querySelector('#cc-chat-close').addEventListener('click', () => {
    chatSearchEl._cleanup?.();
    chatSearchEl.remove();
    chatSearchEl = null;
  });
  // 헤더 드래그로 이동
  const header = chatSearchEl.firstElementChild;
  header.style.cursor = 'move';
  header.addEventListener('mousedown', (ev) => {
    if (ev.target.tagName === 'BUTTON') return;
    const rect = chatSearchEl.getBoundingClientRect();
    const sx = ev.clientX, sy = ev.clientY, ox = rect.left, oy = rect.top;
    const onMove = (e2) => {
      const nx = Math.max(0, Math.min(window.innerWidth - rect.width, ox + e2.clientX - sx));
      const ny = Math.max(0, Math.min(window.innerHeight - 40, oy + e2.clientY - sy));
      chatSearchEl.style.left = nx + 'px';
      chatSearchEl.style.top = ny + 'px';
      chatSearchEl.style.right = 'auto';
      chatSearchEl.style.bottom = 'auto';
    };
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    ev.preventDefault();
  });
  const modeEl = chatSearchEl.querySelector('#cc-chat-mode');
  const clearBtn = chatSearchEl.querySelector('#cc-chat-clear');
  clearBtn.addEventListener('click', async () => {
    if (!confirm('이 채널의 누적된 채팅 기록을 모두 삭제할까요?')) return;
    await dbDeleteChats(cid);
    chatBufferByCid.set(cid, []);
    chatSeenByCid.set(cid, new Map());
    render();
  });
  // DB에서 과거 채팅 로드해서 메모리 버퍼에 머지 (중복은 dedupe Set이 흡수)
  const loadFromDb = async () => {
    try {
      const rows = await dbGetChats(cid, 10000);
      const buf = chatBufferByCid.get(cid) || [];
      let seen = chatSeenByCid.get(cid);
      if (!seen) { seen = new Map(); chatSeenByCid.set(cid, seen); }
      for (const r of rows) {
        const key = chatDedupeKey(r.uid, r.msg);
        if (seen.has(key)) continue;
        seen.set(key, r.ts);
        buf.push({ ts: r.ts, uid: r.uid, nickname: r.nickname, role: r.role, msg: r.msg, emojis: r.emojis || null });
      }
      buf.sort((a, b) => a.ts - b.ts);
      chatBufferByCid.set(cid, buf);
    } catch (_) {}
    modeEl.textContent = '실시간';
    render();
  };
  loadFromDb();
  // 기본/구독/치트키 이모지 카탈로그 비동기 로드
  fetchEmojiCatalog(cid).then((map) => { if (map) render(); });
  const render = () => {
    const q = input.value.trim().toLowerCase();
    const src = chatBufferByCid.get(cid) || [];
    const filtered = q ? src.filter((m) => (m.msg || '').toLowerCase().includes(q) || (m.nickname || '').toLowerCase().includes(q)) : src;
    cnt.textContent = `${filtered.length}건 / 누적 ${src.length}`;
    const recent = filtered.slice(-200); // 위=과거, 아래=최신
    const wasAtBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 30;
    out.innerHTML = recent.map((m) => {
      const t = new Date(m.ts);
      const time = `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}:${String(t.getSeconds()).padStart(2,'0')}`;
      const roleColor = m.role === 'streamer' ? '#1AE192' : m.role === 'streaming_channel_manager' || m.role === 'streaming_chat_manager' ? '#749FFE' : '#bbb';
      const isMe = myUserIdHash && m.uid === myUserIdHash;
      const label = m.nickname || m.uid.slice(0, 8);
      return `<div style="padding:4px 0;border-bottom:1px solid #2a2a2f;">
        <div style="font-size:11px;color:#888;">${time} · <span style="color:${roleColor};font-weight:600;">${escapeHtml(label)}</span>${isMe ? ' <span style="color:#888;">· 나</span>' : ''}</div>
        <div style="margin-top:2px;word-break:break-all;">${renderMsgHtml(m.msg, m.emojis, emojiCatalogByCid.get(cid)?.map)}</div>
      </div>`;
    }).join('') || '<div style="color:#888;padding:8px 0;">결과 없음</div>';
    if (wasAtBottom) out.scrollTop = out.scrollHeight;
  };
  let timer = null;
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(render, 100); });
  // 실시간 채팅 들어오면 자동 갱신 (디바운스)
  let liveTimer = null;
  chatSearchEl._onIncoming = () => { clearTimeout(liveTimer); liveTimer = setTimeout(render, 300); };
  render();
  out.scrollTop = out.scrollHeight; // 첫 렌더는 항상 최신 위치로
  input.focus();
}
// 디버깅: 권한 없어도 채팅 검색 버튼 노출. 콘솔에서 window.CC_FORCE_CHAT_BTN = false로 끄기 가능
window.CC_FORCE_CHAT_BTN = true;
async function ensureChatSearchButton() {
  const cid = currentLiveCid();
  const row = document.querySelector('#cc-followings-panel .cc-fp-row1');
  const existing = row?.querySelector('.cc-fp-chat-search');
  if (!cid || !row) { existing?.remove(); return; }
  if (existing && existing.dataset.cid === cid) return;
  existing?.remove();
  const isManager = window.CC_FORCE_CHAT_BTN || await checkManagerRole(cid);
  if (!isManager) return;
  const btn = document.createElement('button');
  btn.className = 'cc-fp-chat-search';
  btn.dataset.cid = cid;
  btn.type = 'button';
  btn.textContent = '🔍';
  btn.title = '이 방송 채팅 누적 검색 (매니저)';
  btn.addEventListener('click', () => openChatSearchPanel(cid));
  // 📌 옆 (📌 → 🔍 → ↻ 순)
  const refreshBtn = row.querySelector('.cc-fp-refresh');
  if (refreshBtn) row.insertBefore(btn, refreshBtn);
  else row.appendChild(btn);
}
setInterval(ensureChatSearchButton, 3000);
setTimeout(() => { getMyUserIdHash(); ensureChatSearchButton(); }, 500);

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
    const liveSet = new Set();
    const byCid = new Map(cachedFollowings.map((f) => [f.channelId, f]));
    for (const it of list) {
      const cid = it.channelId || it.channel?.channelId;
      if (!cid) continue;
      liveSet.add(cid);
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
      const f = byCid.get(cid);
      if (f) {
        f.openLive = true;
        f.liveTitle = li.liveTitle || f.liveTitle || '';
        f.liveCategoryValue = li.liveCategoryValue || li.categoryValue || f.liveCategoryValue || '';
        f.concurrentUserCount = Number(li.concurrentUserCount || 0) || 0;
      }
    }
    for (const f of cachedFollowings) {
      if (!liveSet.has(f.channelId)) {
        f.openLive = false;
        f.liveTitle = '';
        f.concurrentUserCount = 0;
      }
    }
  } catch (_) {}
}

const FOLLOWINGS_CACHE_KEY = 'followings_cache_v1';
// 팔로잉 목록은 명시적 ↻ 또는 언팔로우 전까지 무기한 캐시 (불필요한 요청 줄이기)
async function loadFollowingsCache() {
  const obj = await chrome.storage.local.get(FOLLOWINGS_CACHE_KEY);
  const c = obj[FOLLOWINGS_CACHE_KEY];
  if (!c || !Array.isArray(c.list) || !c.list.length) return null;
  return c.list.map((f) => ({ ...f, openLive: false, liveTitle: '', concurrentUserCount: 0 }));
}
async function saveFollowingsCache(list) {
  const minimal = list.map((f) => ({
    channelId: f.channelId,
    channelName: f.channelName,
    channelImageUrl: f.channelImageUrl,
    liveCategoryValue: f.liveCategoryValue || '',
  }));
  await chrome.storage.local.set({ [FOLLOWINGS_CACHE_KEY]: { list: minimal, fetchedAt: Date.now() } });
}
async function invalidateFollowingsCache() {
  await chrome.storage.local.remove(FOLLOWINGS_CACHE_KEY);
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
      <div class="cc-fp-tabs"></div>
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
    if (viewMode === 'catfollow') {
      if (anyCollapsed) {
        for (const c of (followedCategoriesCache.list || [])) {
          catFollowExpanded.add(c.categoryType + ':' + c.categoryId);
        }
      } else {
        catFollowExpanded.clear();
      }
    } else if (anyCollapsed) {
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
  panelEl.querySelector('.cc-fp-refresh').addEventListener('click', () => {
    refresh._forceFull = true;
    invalidateCatFollowingCache().catch(() => {});
    categoryLivesCache.clear();
    if (viewMode === 'catfollow') fetchFollowedCategories({ force: true }).then(() => renderBody()).catch(() => {});
    refresh();
  });
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

const TAB_DESCRIPTORS = [
  { id: 'custom', label: '내 그룹', emoji: '👥', title: '내 그룹' },
  { id: 'bygame', label: '게임별', emoji: '🎮', title: '게임별' },
  { id: 'catfollow', label: '카테고리', emoji: '📺', title: '팔로잉한 카테고리의 라이브' },
  { id: 'subscribe', label: '구독', emoji: '⭐', title: '내 구독 채널' },
  { id: 'watchparty', label: '같이보기', emoji: '🎬', title: '같이보기' },
  { id: 'drops', label: '드롭스', emoji: '🎁', title: '드롭스' },
  { id: 'bytag', label: '태그', emoji: '🏷', title: '태그별' },
];
const TAB_ORDER_KEY = 'cc_tab_order'; // [{id, main}, ...]
let tabOrder = null; // 캐시
function defaultTabOrder() {
  return TAB_DESCRIPTORS.map((d, i) => ({ id: d.id, main: i < 3 }));
}
async function loadTabOrder() {
  if (tabOrder) return tabOrder;
  try {
    const obj = await chrome.storage.local.get(TAB_ORDER_KEY);
    const stored = obj[TAB_ORDER_KEY];
    if (Array.isArray(stored) && stored.length) {
      // 누락된 탭 채워주기
      const known = new Set(stored.map((x) => x.id));
      for (const d of TAB_DESCRIPTORS) if (!known.has(d.id)) stored.push({ id: d.id, main: false });
      tabOrder = stored.filter((x) => TAB_DESCRIPTORS.find((d) => d.id === x.id));
    } else {
      tabOrder = defaultTabOrder();
    }
  } catch (_) { tabOrder = defaultTabOrder(); }
  return tabOrder;
}
async function saveTabOrder() {
  if (!tabOrder) return;
  await chrome.storage.local.set({ [TAB_ORDER_KEY]: tabOrder });
}
function tabDescriptor(id) { return TAB_DESCRIPTORS.find((d) => d.id === id); }

function renderTabs(panel) {
  const container = panel.querySelector('.cc-fp-tabs');
  if (!container) return;
  loadTabOrder().then(() => {
    const main = tabOrder.filter((x) => x.main).map((x) => tabDescriptor(x.id)).filter(Boolean);
    const overflow = tabOrder.filter((x) => !x.main).map((x) => tabDescriptor(x.id)).filter(Boolean);
    // 현재 활성 viewMode가 overflow에 있으면 main 표시용으로 끌어올림
    const activeInOverflow = overflow.find((d) => d.id === viewMode);
    const mainAndActive = activeInOverflow ? [...main, activeInOverflow] : main;
    container.innerHTML = mainAndActive.map((d) => `
      <button class="cc-fp-tab" data-view="${d.id}" type="button" title="${escapeHtml(d.title)}">
        <span class="cc-fp-tab-emoji">${d.emoji}</span><span class="cc-fp-tab-label">${escapeHtml(d.label)}</span>
      </button>
    `).join('') + (overflow.length ? `
      <button class="cc-fp-tab cc-fp-tab-more" type="button" title="더보기">⋯</button>
    ` : '');
    bindTabEvents(panel);
    updateActiveTab(panel);
    measureTabWidth(panel);
  });
}

let tabResizeObserver = null;
function measureTabWidth(panel) {
  const tabs = panel.querySelector('.cc-fp-tabs');
  if (!tabs) return;
  // 텍스트 보이게 한 상태에서 스크롤 폭 확인. 넘치면 아이콘 모드로
  tabs.classList.remove('cc-tabs-iconly');
  if (tabs.scrollWidth > tabs.clientWidth + 1) {
    tabs.classList.add('cc-tabs-iconly');
  }
  if (!tabResizeObserver) {
    tabResizeObserver = new ResizeObserver(() => measureTabWidth(panel));
    tabResizeObserver.observe(tabs);
  }
}

function bindTabEvents(panel) {
  panel.querySelectorAll('.cc-fp-tab').forEach((t) => {
    if (t.classList.contains('cc-fp-tab-more')) {
      t.addEventListener('click', (e) => openTabOverflowMenu(panel, e.currentTarget));
    } else {
      t.addEventListener('click', () => {
        viewMode = t.dataset.view;
        chrome.storage.local.set({ [VIEW_KEY]: viewMode });
        renderTabs(panel);
        renderBody();
      });
      t.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openTabContextMenu(panel, t, e.clientX, e.clientY);
      });
    }
  });
}

function bindViewTabs(panel) { renderTabs(panel); }
function updateActiveTab(panel) {
  panel.querySelectorAll('.cc-fp-tab').forEach((t) => t.classList.toggle('cc-active', t.dataset.view === viewMode));
}

let tabOverflowEl = null;
function closeTabOverflow() { tabOverflowEl?.remove(); tabOverflowEl = null; }
function openTabOverflowMenu(panel, anchor) {
  closeTabOverflow();
  const rect = anchor.getBoundingClientRect();
  const overflow = tabOrder.filter((x) => !x.main).map((x) => tabDescriptor(x.id)).filter(Boolean);
  tabOverflowEl = document.createElement('div');
  tabOverflowEl.id = 'cc-tab-overflow';
  tabOverflowEl.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.bottom + 4}px;z-index:2147483647;background:rgba(20,20,24,0.97);border:1px solid #444;border-radius:6px;box-shadow:0 6px 20px rgba(0,0,0,0.5);min-width:160px;padding:4px 0;font:13px -apple-system,sans-serif;color:#eee;`;
  tabOverflowEl.innerHTML = overflow.map((d) => `
    <button data-view="${d.id}" style="display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:transparent;border:none;color:#eee;padding:8px 12px;cursor:pointer;font-size:13px;">
      <span>${d.emoji}</span><span>${escapeHtml(d.label)}</span>
    </button>
  `).join('') + `
    <div style="height:1px;background:#333;margin:4px 0;"></div>
    <button data-act="tab-settings" style="display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:transparent;border:none;color:#aaa;padding:8px 12px;cursor:pointer;font-size:12px;">⚙️ 탭 설정…</button>
  `;
  document.body.appendChild(tabOverflowEl);
  tabOverflowEl.addEventListener('click', (e) => {
    const settings = e.target.closest('button[data-act="tab-settings"]');
    if (settings) { closeTabOverflow(); openTabSettings(panel); return; }
    const btn = e.target.closest('button[data-view]');
    if (!btn) return;
    closeTabOverflow();
    viewMode = btn.dataset.view;
    chrome.storage.local.set({ [VIEW_KEY]: viewMode });
    renderTabs(panel);
    renderBody();
  });
  setTimeout(() => {
    const off = (ev) => { if (!ev.target.closest('#cc-tab-overflow')) { closeTabOverflow(); window.removeEventListener('click', off); } };
    window.addEventListener('click', off);
  }, 0);
}

let tabCtxEl = null;
function openTabContextMenu(panel, tabEl, x, y) {
  tabCtxEl?.remove();
  const id = tabEl.dataset.view;
  const cur = tabOrder.find((t) => t.id === id);
  if (!cur) return;
  tabCtxEl = document.createElement('div');
  tabCtxEl.id = 'cc-ctx-menu';
  tabCtxEl.innerHTML = `
    <button data-act="toggle-main">${cur.main ? '↓ 더보기로 이동' : '↑ 메인으로 이동'}</button>
    <button data-act="tab-settings">⚙️ 탭 설정…</button>
  `;
  tabCtxEl.style.left = x + 'px';
  tabCtxEl.style.top = y + 'px';
  document.body.appendChild(tabCtxEl);
  tabCtxEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    tabCtxEl.remove(); tabCtxEl = null;
    if (btn.dataset.act === 'toggle-main') {
      cur.main = !cur.main;
      await saveTabOrder();
      renderTabs(panel);
    } else if (btn.dataset.act === 'tab-settings') {
      openTabSettings(panel);
    }
  });
  setTimeout(() => {
    const off = (ev) => { if (!ev.target.closest('#cc-ctx-menu')) { tabCtxEl?.remove(); tabCtxEl = null; window.removeEventListener('click', off); } };
    window.addEventListener('click', off);
  }, 0);
}

let tabSettingsEl = null;
function openTabSettings(panel) {
  tabSettingsEl?.remove();
  tabSettingsEl = document.createElement('div');
  tabSettingsEl.id = 'cc-tab-settings';
  tabSettingsEl.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(20,20,24,0.98);border:2px solid #1AE192;border-radius:10px;padding:14px;width:320px;max-height:80vh;overflow:auto;z-index:2147483647;color:#eee;font:13px -apple-system,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,0.6);';
  tabSettingsEl.innerHTML = `
    <div style="display:flex;align-items:center;margin-bottom:10px;">
      <strong style="flex:1;">탭 설정</strong>
      <button id="cc-tab-set-close" style="background:transparent;border:none;color:#ccc;font-size:18px;cursor:pointer;">×</button>
    </div>
    <div style="color:#aaa;font-size:11px;margin-bottom:8px;">드래그하여 순서 변경 / ⭐ 클릭하여 메인 탭 토글</div>
    <div id="cc-tab-set-list"></div>
  `;
  document.body.appendChild(tabSettingsEl);
  const list = tabSettingsEl.querySelector('#cc-tab-set-list');
  function renderList() {
    list.innerHTML = tabOrder.map((t) => {
      const d = tabDescriptor(t.id);
      if (!d) return '';
      return `
        <div class="cc-tab-set-row" draggable="true" data-id="${t.id}" style="display:flex;align-items:center;gap:8px;padding:8px;border:1px solid #333;border-radius:6px;margin-bottom:4px;background:#1a1a1f;cursor:move;">
          <span style="color:#666;">≡</span>
          <span style="font-size:16px;">${d.emoji}</span>
          <span style="flex:1;">${escapeHtml(d.label)}</span>
          <button data-act="toggle" style="background:transparent;border:1px solid #444;color:${t.main ? '#1AE192' : '#666'};border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px;">
            ${t.main ? '★ 메인' : '☆ 더보기'}
          </button>
        </div>
      `;
    }).join('');
  }
  renderList();
  list.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act="toggle"]');
    if (!btn) return;
    const row = btn.closest('.cc-tab-set-row');
    const t = tabOrder.find((x) => x.id === row.dataset.id);
    if (!t) return;
    t.main = !t.main;
    await saveTabOrder();
    renderList();
    renderTabs(panel);
  });
  let draggedId = null;
  list.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.cc-tab-set-row');
    if (!row) return;
    draggedId = row.dataset.id;
    row.style.opacity = '0.4';
  });
  list.addEventListener('dragend', () => {
    list.querySelectorAll('.cc-tab-set-row').forEach((r) => r.style.opacity = '');
    draggedId = null;
  });
  list.addEventListener('dragover', (e) => {
    if (!draggedId) return;
    e.preventDefault();
    const overRow = e.target.closest('.cc-tab-set-row');
    if (!overRow || overRow.dataset.id === draggedId) return;
    const fromIdx = tabOrder.findIndex((x) => x.id === draggedId);
    const toIdx = tabOrder.findIndex((x) => x.id === overRow.dataset.id);
    if (fromIdx < 0 || toIdx < 0) return;
    const [moved] = tabOrder.splice(fromIdx, 1);
    tabOrder.splice(toIdx, 0, moved);
    saveTabOrder();
    renderList();
    renderTabs(panel);
  });
  tabSettingsEl.querySelector('#cc-tab-set-close').addEventListener('click', () => { tabSettingsEl.remove(); tabSettingsEl = null; });
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
  function firstGroupEl() {
    return body.querySelector('.cc-group[data-drop]:not([data-gid="' + OTHER_KEY + '"])');
  }
  body.addEventListener('dragover', (e) => {
    const groupEl = e.target.closest('.cc-group[data-drop]');
    if (!groupEl) {
      // 그룹 드래그 중 첫 그룹 위의 빈 여백 → 맨 위로 이동 허용
      if (isGroupDrag(e.dataTransfer)) {
        const first = firstGroupEl();
        if (first && e.clientY < first.getBoundingClientRect().top) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          clearDropIndicators();
          first.classList.add('cc-drop-above');
        }
      }
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearDropIndicators();
    if (isGroupDrag(e.dataTransfer) && groupEl.dataset.gid !== OTHER_KEY) {
      const head = groupEl.querySelector('.cc-group-head');
      const rect = head.getBoundingClientRect();
      const ratio = (e.clientY - rect.top) / rect.height;
      if (ratio < 0.4) groupEl.classList.add('cc-drop-above');
      else if (ratio > 0.6) groupEl.classList.add('cc-drop-below');
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
    // 빈 여백에 드롭한 경우 dragover에서 마킹해둔 그룹(첫 그룹 위 등)을 대상으로 사용
    const groupEl = e.target.closest('.cc-group[data-drop]')
      || body.querySelector('.cc-group.cc-drop-above, .cc-group.cc-drop-below');
    const chData = e.dataTransfer.getData('text/cc-channel');
    const grpData = e.dataTransfer.getData('text/cc-group');
    if (chData) {
      if (!groupEl) return;
      const { cid, fromGid } = JSON.parse(chData);
      const toGid = groupEl.dataset.gid;
      if (fromGid === toGid) return;
      const ok = viewMode === 'custom' && await partialChannelMove(cid, fromGid, toGid);
      if (ok) return;
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

function cssEsc(s) { return (s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

function sortChannelsCompare(a, b) {
  return (favoriteChannels.has(b.channelId) ? 1 : 0) - (favoriteChannels.has(a.channelId) ? 1 : 0)
      || (b.openLive ? 1 : 0) - (a.openLive ? 1 : 0)
      || (b.concurrentUserCount || 0) - (a.concurrentUserCount || 0)
      || a.channelName.localeCompare(b.channelName);
}

function recomputeGroupCounts(panel) {
  const byId = new Map(cachedFollowings.map((f) => [f.channelId, f]));
  const childrenMap = new Map();
  for (const g of cachedGroups) {
    const p = g.parentId || null;
    if (!childrenMap.has(p)) childrenMap.set(p, []);
    childrenMap.get(p).push(g);
  }
  const live = (g) => (g.channelIds || []).map((id) => byId.get(id)).filter((c) => c && c.openLive).length
    + (childrenMap.get(g.id) || []).reduce((s, c) => s + live(c), 0);
  const total = (g) => (g.channelIds || []).filter((id) => byId.has(id)).length
    + (childrenMap.get(g.id) || []).reduce((s, c) => s + total(c), 0);
  for (const g of cachedGroups) {
    const head = panel.querySelector(`.cc-group[data-gid="${cssEsc(g.id)}"] > .cc-group-head`);
    const countEl = head?.querySelector('.cc-group-count');
    if (countEl) countEl.textContent = `${live(g)} / ${total(g)}`;
  }
  const assigned = new Set();
  for (const g of cachedGroups) for (const id of g.channelIds || []) assigned.add(id);
  const others = cachedFollowings.filter((f) => !assigned.has(f.channelId));
  const otherCount = panel.querySelector(`.cc-group[data-gid="${cssEsc(OTHER_KEY)}"] > .cc-group-head > .cc-group-count`);
  if (otherCount) otherCount.textContent = `${others.filter((c) => c.openLive).length} / ${others.length}`;
}

async function partialChannelMove(cid, fromGid, toGid) {
  const panel = panelEl;
  if (!panel) return false;
  const body = panel.querySelector('.cc-fp-body');
  if (!body) return false;
  const ch = cachedFollowings.find((f) => f.channelId === cid);
  if (!ch) return false;

  // 목적지 group-body 확보 (없으면 부분 갱신 포기)
  const destSel = `.cc-group[data-gid="${cssEsc(toGid)}"] > .cc-group-body`;
  const destBody = body.querySelector(destSel);
  if (!destBody) return false;

  // 메모리/스토리지 업데이트
  for (const g of cachedGroups) g.channelIds = (g.channelIds || []).filter((x) => x !== cid);
  if (toGid !== OTHER_KEY) {
    const target = cachedGroups.find((g) => g.id === toGid);
    if (!target) return false;
    target.channelIds.push(cid);
  }
  skipNextGroupsRefresh = true;
  await chrome.storage.local.set({ [GROUPS_KEY]: cachedGroups });

  // 기존 row 제거
  body.querySelectorAll(`.cc-ch-row[data-cid="${cssEsc(cid)}"]`).forEach((el) => el.remove());

  // 목적지 정렬 순서 계산
  let destCids;
  if (toGid === OTHER_KEY) {
    const assigned = new Set();
    for (const g of cachedGroups) for (const id of g.channelIds || []) assigned.add(id);
    destCids = cachedFollowings.filter((f) => !assigned.has(f.channelId)).map((f) => f.channelId);
  } else {
    destCids = cachedGroups.find((g) => g.id === toGid)?.channelIds || [];
  }
  const destSorted = destCids.map((id) => cachedFollowings.find((f) => f.channelId === id)).filter(Boolean).sort(sortChannelsCompare);
  const insertIndex = destSorted.findIndex((c) => c.channelId === cid);

  // "채널 없음" placeholder 제거
  destBody.querySelector(':scope > .cc-empty')?.remove();

  // 신규 row 생성 & 삽입
  const tmp = document.createElement('div');
  tmp.innerHTML = channelLink(ch, toGid).trim();
  const newRow = tmp.firstElementChild;
  const existingRows = [...destBody.children].filter((el) => el.classList?.contains('cc-ch-row'));
  if (insertIndex >= existingRows.length || insertIndex < 0) {
    const firstNonRow = [...destBody.children].find((el) => !el.classList?.contains('cc-ch-row'));
    if (firstNonRow) destBody.insertBefore(newRow, firstNonRow);
    else destBody.appendChild(newRow);
  } else {
    destBody.insertBefore(newRow, existingRows[insertIndex]);
  }

  // 출발지 그룹이 비었으면 placeholder 표시
  if (fromGid && fromGid !== OTHER_KEY) {
    const srcBody = body.querySelector(`.cc-group[data-gid="${cssEsc(fromGid)}"] > .cc-group-body`);
    if (srcBody) {
      const hasRows = [...srcBody.children].some((el) => el.classList?.contains('cc-ch-row'));
      const hasSub = [...srcBody.children].some((el) => el.classList?.contains('cc-group'));
      const hasForm = !!srcBody.querySelector(':scope > .cc-group-add-input');
      if (!hasRows && !hasSub && !hasForm && !srcBody.querySelector(':scope > .cc-empty')) {
        srcBody.insertAdjacentHTML('beforeend', '<div class="cc-empty">채널 없음</div>');
      }
    }
  }

  recomputeGroupCounts(panel);
  if (ch.openLive) setTimeout(refreshPredictionsForVisible, 100);
  return true;
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
const PREDICTION_TTL_MS = 5 * 60 * 1000; // 5분
const MISSIONS_TTL_MS = 5 * 60 * 1000;
const PRED_STORAGE_KEY = 'pred_cache_v1';
const MISSION_STORAGE_KEY = 'mission_cache_v1';
let predMissionCacheLoaded = false;
async function loadPredMissionCache() {
  if (predMissionCacheLoaded) return;
  predMissionCacheLoaded = true;
  const obj = await chrome.storage.local.get([PRED_STORAGE_KEY, MISSION_STORAGE_KEY]);
  const now = Date.now();
  const p = obj[PRED_STORAGE_KEY] || {};
  for (const [cid, info] of Object.entries(p)) {
    if (info && now - (info.fetchedAt || 0) < PREDICTION_TTL_MS) predictionByCid.set(cid, info);
  }
  const m = obj[MISSION_STORAGE_KEY] || {};
  for (const [cid, info] of Object.entries(m)) {
    if (info && now - (info.fetchedAt || 0) < MISSIONS_TTL_MS) missionsByCid.set(cid, info);
  }
}
let predMissionSaveTimer = null;
function schedulePredMissionSave() {
  clearTimeout(predMissionSaveTimer);
  predMissionSaveTimer = setTimeout(() => {
    const now = Date.now();
    const p = {}, m = {};
    for (const [cid, info] of predictionByCid) if (!info._pending && now - info.fetchedAt < PREDICTION_TTL_MS) p[cid] = info;
    for (const [cid, info] of missionsByCid) if (!info._pending && now - info.fetchedAt < MISSIONS_TTL_MS) m[cid] = info;
    chrome.storage.local.set({ [PRED_STORAGE_KEY]: p, [MISSION_STORAGE_KEY]: m }).catch(() => {});
  }, 800);
}
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
// 동시 요청 수 제한 + 요청 간 간격: 너무 빨리 쏟으면 ERR_CONNECTION_RESET 유발
const PRED_MISSION_CONCURRENCY = 3;
const PRED_MISSION_GAP_MS = 150;
let predMissionRunning = 0;
const predMissionQueue = [];
function schedulePredMission(task) {
  predMissionQueue.push(task);
  drainPredMissionQueue();
}
async function drainPredMissionQueue() {
  while (predMissionRunning < PRED_MISSION_CONCURRENCY && predMissionQueue.length) {
    const task = predMissionQueue.shift();
    predMissionRunning++;
    task().finally(() => {
      predMissionRunning--;
      setTimeout(drainPredMissionQueue, PRED_MISSION_GAP_MS);
    });
  }
}
async function refreshPredictionsForVisible() {
  await loadPredMissionCache();
  const rows = document.querySelectorAll('#cc-followings-panel .cc-ch-row.cc-live');
  for (const row of rows) {
    const cid = row.dataset.cid;
    if (!cid) continue;
    const cachedP = predictionByCid.get(cid);
    if (cachedP && Date.now() - cachedP.fetchedAt < PREDICTION_TTL_MS) applyPredictionBadge(row, cachedP);
    else {
      predictionByCid.set(cid, { fetchedAt: Date.now() - PREDICTION_TTL_MS + 5000, _pending: true }); // 중복 큐잉 방지(5초 윈도)
      schedulePredMission(async () => {
        const p = await fetchPrediction(cid);
        const info = { ...(p || {}), fetchedAt: Date.now() };
        predictionByCid.set(cid, info);
        applyPredictionBadge(row, info);
        schedulePredMissionSave();
      });
    }
    const cachedM = missionsByCid.get(cid);
    if (cachedM && Date.now() - cachedM.fetchedAt < MISSIONS_TTL_MS) applyMissionLine(row, cachedM.list);
    else {
      missionsByCid.set(cid, { list: [], fetchedAt: Date.now() - MISSIONS_TTL_MS + 5000, _pending: true });
      schedulePredMission(async () => {
        const list = await fetchMissions(cid);
        const info = { list: list || [], fetchedAt: Date.now() };
        missionsByCid.set(cid, info);
        applyMissionLine(row, info.list);
        schedulePredMissionSave();
      });
    }
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
  invalidateFollowingsCache().catch(() => {});
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

// ===== 팔로잉 카테고리 라이브 =====
const CAT_FOLLOWING_CACHE_KEY = 'cat_following_cache_v1';
const followedCategoriesCache = { list: null, fetchedAt: 0, loaded: false };
const categoryLivesCache = new Map(); // `${type}:${id}` -> { data, fetchedAt }
const CATEGORY_TTL_MS = 60 * 1000; // 라이브 목록(카테고리 안)에만 적용
async function loadCatFollowingFromStorage() {
  if (followedCategoriesCache.loaded) return;
  followedCategoriesCache.loaded = true;
  try {
    const obj = await chrome.storage.local.get(CAT_FOLLOWING_CACHE_KEY);
    const c = obj[CAT_FOLLOWING_CACHE_KEY];
    if (c && Array.isArray(c.list)) {
      followedCategoriesCache.list = c.list;
      followedCategoriesCache.fetchedAt = c.fetchedAt || 0;
    }
  } catch (_) {}
}
async function invalidateCatFollowingCache() {
  followedCategoriesCache.list = null;
  followedCategoriesCache.fetchedAt = 0;
  try { await chrome.storage.local.remove(CAT_FOLLOWING_CACHE_KEY); } catch (_) {}
}
async function fetchFollowedCategories({ force = false } = {}) {
  await loadCatFollowingFromStorage();
  // 캐시 무기한 (↻ 새로고침 또는 카테고리 팔/언팔 시점에 무효화)
  if (!force && followedCategoriesCache.list) return followedCategoriesCache.list;
  let all = [];
  try {
    const r = await fetch('https://api.chzzk.naver.com/service/v1/categories/following?size=100', { credentials: 'include', cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      const c = j?.content || {};
      if (Array.isArray(c.followingList)) all = c.followingList;
      else if (Array.isArray(c.followingList?.data)) all = c.followingList.data;
      else if (Array.isArray(c.data)) all = c.data;
      else if (Array.isArray(c.followings)) all = c.followings;
    }
  } catch (_) {}
  followedCategoriesCache.list = all;
  followedCategoriesCache.fetchedAt = Date.now();
  try { await chrome.storage.local.set({ [CAT_FOLLOWING_CACHE_KEY]: { list: all, fetchedAt: Date.now() } }); } catch (_) {}
  return all;
}
async function fetchCategoryLives(type, id, cursor = null) {
  const key = `${type}:${id}`;
  if (!cursor) {
    const cached = categoryLivesCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < CATEGORY_TTL_MS) return cached;
  }
  try {
    let url = `https://api.chzzk.naver.com/service/v2/categories/${encodeURIComponent(type)}/${encodeURIComponent(id)}/lives`;
    if (cursor?.liveId != null) {
      url += `?concurrentUserCount=${encodeURIComponent(cursor.concurrentUserCount ?? 0)}&liveId=${encodeURIComponent(cursor.liveId)}`;
    }
    const r = await fetch(url, { credentials: 'include', cache: 'no-store' });
    if (!r.ok) return { data: [], next: null };
    const j = await r.json();
    const data = j?.content?.data || [];
    const next = j?.content?.page?.next || null;
    const result = { data, next, fetchedAt: Date.now() };
    if (!cursor) categoryLivesCache.set(key, result);
    return result;
  } catch (_) { return { data: [], next: null }; }
}
function renderCategoryFollowing() {
  setTimeout(populateCategoryFollowing, 0);
  return '<div class="cc-empty">팔로잉한 카테고리 로딩 중…</div>';
}
const catFollowExpanded = new Set(); // `${type}:${id}` 펼친 카테고리들
function renderCategoryLivesHtml(lives, q = '', initialsQ = null) {
  const filtered = q ? lives.filter((s) => matchesLiveQuery(s, q, initialsQ)) : lives;
  if (!filtered.length) return `<div class="cc-empty" style="font-size:11px;">${q ? '일치하는 라이브 없음' : '라이브 없음'}</div>`;
  return filtered.map((s) => {
    const ch = s.channel || {};
    const viewers = formatViewers(s.concurrentUserCount || 0);
    const img = ch.channelImageUrl ? `<img src="${escapeHtml(ch.channelImageUrl)}" onerror="this.style.display='none'">` : '<span class="cc-ch-noimg"></span>';
    return `
      <div class="cc-ch-row cc-live" title="${escapeHtml((s.liveTitle || '') + '\n— ' + (ch.channelName || ''))}">
        <a class="cc-ch-link" href="https://chzzk.naver.com/live/${encodeURIComponent(ch.channelId || '')}">
          ${img}
          <div class="cc-ch-text">
            <div class="cc-ch-line1">
              <span class="cc-ch-name">${escapeHtml(ch.channelName || '')}</span>
              <span class="cc-live-count">${escapeHtml(viewers)}</span>
            </div>
            <div class="cc-ch-line2">
              <span class="cc-live-dot" title="LIVE"></span>
              <span class="cc-ch-title">${escapeHtml(s.liveTitle || '')}</span>
            </div>
          </div>
        </a>
      </div>
    `;
  }).join('');
}
function matchesLiveQuery(s, q, initialsQ) {
  if (!q) return true;
  const title = (s.liveTitle || '').toLowerCase();
  const name = (s.channel?.channelName || '').toLowerCase();
  if (title.includes(q) || name.includes(q)) return true;
  if (initialsQ) {
    if (toInitials(s.liveTitle || '').includes(initialsQ)) return true;
    if (toInitials(s.channel?.channelName || '').includes(initialsQ)) return true;
  }
  const tags = Array.isArray(s.tags) ? s.tags : [];
  if (tags.some((t) => (t || '').toLowerCase().includes(q))) return true;
  if (initialsQ && tags.some((t) => toInitials(t || '').includes(initialsQ))) return true;
  return false;
}
async function populateCategoryFollowing() {
  if (!panelEl) return;
  const body = panelEl.querySelector('.cc-fp-body');
  if (!body) return;
  if (viewMode !== 'catfollow') return;
  const cats = await fetchFollowedCategories();
  if (viewMode !== 'catfollow') return;
  if (!cats.length) { body.innerHTML = '<div class="cc-empty">팔로잉한 카테고리가 없습니다.</div>'; return; }
  const q = searchQuery.trim().toLowerCase();
  body.innerHTML = cats.map((c) => {
    const key = c.categoryType + ':' + c.categoryId;
    // 검색 중에는 모든 카테고리 자동으로 펼침 (각 카테고리 안에서 채널 검색)
    const expanded = q ? true : catFollowExpanded.has(key);
    return `
      <div class="cc-group ${expanded ? '' : 'cc-group-collapsed'}" data-cat-key="${escapeHtml(key)}">
        <div class="cc-group-head" data-act="toggle-cat" style="--cc-c:#1AE192;cursor:pointer;">
          <span class="cc-caret">${expanded ? '▼' : '▶'}</span>
          <img src="${escapeHtml(c.posterImageUrl || '')}" style="width:18px;height:18px;border-radius:3px;margin-right:6px;object-fit:cover;" onerror="this.style.display='none'">
          <span class="cc-group-name">${escapeHtml(c.categoryValue || c.categoryId)}</span>
          <span class="cc-group-count">${c.openLiveCount || 0} LIVE</span>
        </div>
        <div class="cc-group-body" data-cat-body="1"></div>
      </div>
    `;
  }).join('');
  // 펼쳐진 카테고리(검색 중이면 모두) 자동 로드
  for (const c of cats) {
    const key = c.categoryType + ':' + c.categoryId;
    if (q || catFollowExpanded.has(key)) loadCategoryLivesInto(body, c);
  }
  // 헤더 클릭으로 토글 + lazy load
  if (!body._ccCatBound) {
    body._ccCatBound = true;
    body.addEventListener('click', (e) => {
      if (viewMode !== 'catfollow') return;
      const more = e.target.closest('button[data-act="cat-more"]');
      if (more) {
        e.preventDefault();
        const group = more.closest('.cc-group');
        const box = group?.querySelector('.cc-group-body');
        const key = group?.dataset.catKey;
        if (!box || !key) return;
        const cursor = box._nextCursor;
        if (!cursor) return;
        const [type, id] = key.split(':');
        const c = followedCategoriesCache.list?.find((x) => x.categoryType === type && x.categoryId === id);
        if (c) loadCategoryLivesInto(body, c, cursor);
        return;
      }
      const head = e.target.closest('.cc-group-head[data-act="toggle-cat"]');
      if (!head) return;
      const group = head.closest('.cc-group');
      const key = group?.dataset.catKey;
      if (!key) return;
      const [type, id] = key.split(':');
      const wasExpanded = !group.classList.contains('cc-group-collapsed');
      group.classList.toggle('cc-group-collapsed', wasExpanded);
      head.querySelector('.cc-caret').textContent = wasExpanded ? '▶' : '▼';
      if (wasExpanded) catFollowExpanded.delete(key);
      else {
        catFollowExpanded.add(key);
        const c = followedCategoriesCache.list?.find((x) => x.categoryType === type && x.categoryId === id);
        if (c) loadCategoryLivesInto(body, c);
      }
    });
  }
}
async function loadCategoryLivesInto(body, c, cursor = null) {
  const sel = `.cc-group[data-cat-key="${cssEsc(c.categoryType + ':' + c.categoryId)}"] > .cc-group-body`;
  const box = body.querySelector(sel);
  if (!box) return;
  if (!cursor) box.innerHTML = '<div class="cc-empty" style="font-size:11px;">로딩 중…</div>';
  const res = await fetchCategoryLives(c.categoryType, c.categoryId, cursor);
  if (viewMode !== 'catfollow') return;
  const stillBox = body.querySelector(sel);
  if (!stillBox) return;
  // 누적된 데이터: 첫 페이지면 새로 그리고, cursor면 기존 끝에 append
  if (!cursor) stillBox._allData = [];
  stillBox._allData = (stillBox._allData || []).concat(res.data || []);
  stillBox._nextCursor = res.next || null;
  // 기존 "더 보기" 버튼 제거 후 다시 렌더
  const q = searchQuery.trim().toLowerCase();
  const initialsQ = /^[ㄱ-ㅎ]+$/.test(q) ? q : null;
  const filtered = q ? stillBox._allData.filter((s) => matchesLiveQuery(s, q, initialsQ)) : stillBox._allData;
  stillBox.innerHTML = renderCategoryLivesHtml(stillBox._allData, q, initialsQ)
    + (stillBox._nextCursor ? `<button data-act="cat-more" style="display:block;width:100%;background:#2a2a32;border:1px solid #444;color:#1AE192;border-radius:4px;padding:6px;margin-top:6px;cursor:pointer;font-size:11px;">더 보기 ▼</button>` : '');
  // 검색 중인데 해당 카테고리에 매칭되는 라이브가 없으면 카테고리 자체를 숨김
  const groupEl = stillBox.closest('.cc-group');
  if (groupEl) groupEl.style.display = (q && filtered.length === 0) ? 'none' : '';
  stillBox._loaded = true;
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
    const forceFull = refresh._forceFull === true;
    refresh._forceFull = false;
    const groups = await readGroups();
    cachedGroups = groups;
    applyDefaultCollapse(groups);
    let cachedList = forceFull ? null : await loadFollowingsCache();
    if (cachedList) {
      log(`cache hit n=${cachedList.length}`);
      cachedFollowings = cachedList;
      renderBody();
      // 라이브 상태만 비동기로 덮어쓰기
      fetchFollowingLives().then(() => { renderBody(); log('live merged'); }).catch(() => {});
    } else {
      log('full followings fetch start');
      const followings = await fetchFollowings();
      log(`fetched followings=${followings.length}`);
      cachedFollowings = followings;
      saveFollowingsCache(followings).catch(() => {});
      renderBody();
      fetchFollowingLives().then(() => renderBody()).catch(() => {});
    }
    log('rendered');
    refresh._attempt = 0;
  } catch (e) {
    log('error: ' + e.message);
    const attempt = (refresh._attempt || 0) + 1;
    if (attempt <= 3 && /fetch|network|reset/i.test(e.message || '')) {
      const delay = 800 * attempt;
      refresh._attempt = attempt;
      body.innerHTML = `<div class="cc-empty" style="color:#e0a93b">네트워크 일시 오류, ${attempt}/3 재시도 중…</div>`;
      setTimeout(() => { refresh().catch(() => {}); }, delay);
      return;
    }
    refresh._attempt = 0;
    body.innerHTML = `<div class="cc-empty" style="color:#e74c3c">로드 실패: ${escapeHtml(e.message)} <button class="cc-fp-refresh" style="margin-left:6px;background:#1AE192;color:#111;border:none;padding:2px 8px;border-radius:4px;cursor:pointer;">다시 시도</button></div>`;
    body.querySelector('button')?.addEventListener('click', () => { refresh._attempt = 0; refresh(); });
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
    : viewMode === 'catfollow' ? renderCategoryFollowing()
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
  if (['custom', 'bygame', 'subscribe', 'watchparty', 'drops', 'bytag', 'catfollow'].includes(obj[VIEW_KEY])) viewMode = obj[VIEW_KEY];
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
  const moveTargets = cachedGroups
    .filter((g) => g.id !== fromGid)
    .sort((a, b) => (a.parentId || '').localeCompare(b.parentId || '') || (a.order || 0) - (b.order || 0));
  const items = [
    { act: 'fav-toggle', label: isFav ? '⚡ 즐겨찾기 해제' : '⚡ 즐겨찾기' },
    { act: 'notify-toggle', label: isNotify ? '🔔 알림 해제' : '🔕 알림 받기' },
    inGroup ? { act: 'remove-from-group', label: '↩ 이 그룹에서 제거', cls: 'cc-ctx-warn' } : null,
    ...(moveTargets.length ? [{ sep: true }, { header: '📁 그룹으로 이동' },
      ...moveTargets.map((g) => ({ act: 'move-to-group', gid: g.id, label: `  ${g.name}`, color: g.color || '#1AE192' }))] : []),
    { sep: true },
    { act: 'unfollow', label: '✕ 팔로우 취소', cls: 'cc-ctx-danger' },
  ].filter(Boolean);
  ctxMenuEl = document.createElement('div');
  ctxMenuEl.id = 'cc-ctx-menu';
  ctxMenuEl.innerHTML = items.map((it) => {
    if (it.sep) return '<div class="cc-ctx-sep"></div>';
    if (it.header) return `<div class="cc-ctx-header">${escapeHtml(it.header)}</div>`;
    const dot = it.color ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${escapeHtml(it.color)};margin-right:6px;vertical-align:middle;"></span>` : '';
    const gidAttr = it.gid ? ` data-gid="${escapeHtml(it.gid)}"` : '';
    return `<button data-act="${it.act}"${gidAttr} class="${it.cls || ''}">${dot}${escapeHtml(it.label)}</button>`;
  }).join('');
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
    } else if (act === 'move-to-group') {
      const toGid = btn.dataset.gid;
      if (!toGid || toGid === fromGid) return;
      const ok = viewMode === 'custom' && await partialChannelMove(cid, fromGid || OTHER_KEY, toGid);
      if (ok) return;
      const groups = await readGroups();
      for (const g of groups) g.channelIds = (g.channelIds || []).filter((x) => x !== cid);
      const target = groups.find((g) => g.id === toGid);
      if (target) target.channelIds.push(cid);
      await chrome.storage.local.set({ [GROUPS_KEY]: groups });
      refresh();
    } else if (act === 'remove-from-group') {
      const ok = viewMode === 'custom' && await partialChannelMove(cid, fromGid, OTHER_KEY);
      if (ok) return;
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
    e.preventDefault();
    const row = e.target.closest('.cc-ch-row');
    if (!row) return;
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
  if (changes[GROUPS_KEY]) {
    if (skipNextGroupsRefresh) { skipNextGroupsRefresh = false; }
    else refresh();
  }
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
