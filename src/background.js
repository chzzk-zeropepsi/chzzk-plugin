// CHZZK Companion - background service worker
// 알림 대상 채널의 라이브 전환(off->on) 감지 + Firebase 동기화

import { syncOnce, listenAndPush, checkLatestVersion } from './lib/sync.js';

const ALARM_NAME = 'cc-notify-poll';
const SYNC_ALARM = 'cc-sync-poll';
const SUB_ALARM = 'cc-sub-poll';
const SYNC_PERIOD_MIN = 10;
const POLL_PERIOD_MIN = 1;
const SUB_PERIOD_MIN = 1; // 구독 선물 폴링 주기
const NOTIFY_KEY = 'notify_channels';
const STATE_KEY = 'notify_states';
const SUB_SNAPSHOT_KEY = 'cc_subscribe_snapshot';

function setupAlarms() {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_PERIOD_MIN });
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MIN });
  chrome.alarms.create(SUB_ALARM, { periodInMinutes: SUB_PERIOD_MIN });
}
chrome.runtime.onInstalled.addListener(() => { setupAlarms(); syncOnce().catch(() => {}); pollSubscriptions(true).catch(() => {}); });
chrome.runtime.onStartup?.addListener(() => { setupAlarms(); syncOnce().catch(() => {}); pollSubscriptions(true).catch(() => {}); });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) pollLiveTransitions().catch(() => {});
  if (alarm.name === SYNC_ALARM) syncOnce().catch(() => {});
  if (alarm.name === SUB_ALARM) pollSubscriptions(false).catch(() => {});
});


listenAndPush();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'pollNow') { pollLiveTransitions().then(() => sendResponse({ ok: true })); return true; }
  if (msg?.type === 'seedState') { seedChannelState(msg.channelId).then((r) => sendResponse(r)); return true; }
  if (msg?.type === 'clearState') { clearChannelState(msg.channelId).then(() => sendResponse({ ok: true })); return true; }
  if (msg?.type === 'cc-fetch-json') {
    (async () => {
      const tabs = await chrome.tabs.query({ url: 'https://chzzk.naver.com/*' });
      if (!tabs.length) { sendResponse({ error: '치지직 탭을 먼저 열어주세요' }); return; }
      const tab = tabs[0];
      try {
        const res = await chrome.tabs.sendMessage(tab.id, { type: 'cc-fetch-json-proxy', url: msg.url });
        sendResponse(res);
      } catch (e) {
        sendResponse({ error: String(e.message ?? e) });
      }
    })();
    return true;
  }
  if (msg?.type === 'cc-bg-fetch-text') {
    fetch(msg.url, { credentials: 'omit', cache: 'no-store' })
      .then(async (r) => ({ ok: r.ok, status: r.status, text: await r.text() }))
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e.message ?? e) }));
    return true;
  }
  if (msg?.type === 'cc-bg-fetch-bin') {
    fetch(msg.url, { credentials: 'omit', cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) return { ok: false, status: r.status };
        const buf = await r.arrayBuffer();
        const u8 = new Uint8Array(buf);
        let bin = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < u8.length; i += CHUNK) {
          bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
        }
        return { ok: true, status: r.status, b64: btoa(bin) };
      })
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e.message ?? e) }));
    return true;
  }
  if (msg?.type === 'cc-sync-now') {
    syncOnce().then((r) => sendResponse({ ok: true, r })).catch((e) => sendResponse({ error: String(e.message ?? e) }));
    return true;
  }
  if (msg?.type === 'cc-check-version') {
    checkLatestVersion().then((r) => sendResponse({ ok: true, info: r })).catch((e) => sendResponse({ error: String(e.message ?? e) }));
    return true;
  }
  if (msg?.type === 'cc-download') {
    chrome.downloads.download({ url: msg.url, filename: msg.filename, saveAs: false })
      .then((id) => sendResponse({ ok: true, id }))
      .catch((e) => sendResponse({ error: String(e.message ?? e) }));
    return true;
  }
  return false;
});

async function proxyFetchJson(url) {
  const tabs = await chrome.tabs.query({ url: 'https://chzzk.naver.com/*' });
  if (!tabs.length) throw new Error('no-chzzk-tab');
  const res = await chrome.tabs.sendMessage(tabs[0].id, { type: 'cc-fetch-json-proxy', url });
  if (!res?.ok) throw new Error(res?.error || 'proxy-fail');
  return res.data;
}

async function seedChannelState(channelId) {
  if (!channelId) return { ok: false };
  let openLive = null;
  try {
    const j = await proxyFetchJson(`https://api.chzzk.naver.com/polling/v2/channels/${encodeURIComponent(channelId)}/live-status`);
    const c = j?.content ?? {};
    openLive = c.status ? c.status === 'OPEN' : !!c.openLive;
  } catch (_) {}
  const { [STATE_KEY]: prev = {} } = await chrome.storage.local.get(STATE_KEY);
  prev[channelId] = openLive === true;
  await chrome.storage.local.set({ [STATE_KEY]: prev });
  return { ok: true, openLive };
}

async function clearChannelState(channelId) {
  if (!channelId) return;
  const { [STATE_KEY]: prev = {} } = await chrome.storage.local.get(STATE_KEY);
  delete prev[channelId];
  await chrome.storage.local.set({ [STATE_KEY]: prev });
}

async function fetchFollowingsAll({ size = 100, maxPages = 20 } = {}) {
  const all = [];
  for (let page = 0; page < maxPages; page++) {
    const j = await proxyFetchJson(`https://api.chzzk.naver.com/service/v1/channels/followings?page=${page}&size=${size}&sortType=FOLLOW`);
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
  return all.map(normalizeItem).filter((x) => x.channelId);
}

function normalizeItem(item) {
  const ch = item?.channel ?? item;
  const streamer = item?.streamer ?? {};
  const live = item?.liveInfo ?? item?.live ?? streamer?.liveInfo ?? null;
  return {
    channelId: ch?.channelId || '',
    channelName: ch?.channelName || '',
    channelImageUrl: ch?.channelImageUrl || '',
    openLive: !!(ch?.openLive ?? item?.openLive ?? streamer?.openLive ?? live?.openLive ?? live?.status === 'OPEN'),
    liveTitle: live?.liveTitle || item?.liveTitle || ch?.liveTitle || '',
    liveCategoryValue: live?.liveCategoryValue || live?.categoryValue || item?.liveCategoryValue || ch?.liveCategoryValue || '',
  };
}

async function pollLiveTransitions() {
  const { [NOTIFY_KEY]: targets = [], [STATE_KEY]: prevStates = {} } = await chrome.storage.local.get([NOTIFY_KEY, STATE_KEY]);
  if (!targets.length) return;
  const targetSet = new Set(targets);
  let followings;
  try { followings = await fetchFollowingsAll(); } catch (_) { return; }
  const newStates = { ...prevStates };
  const transitions = [];
  for (const f of followings) {
    if (!targetSet.has(f.channelId)) continue;
    const wasLive = !!prevStates[f.channelId];
    newStates[f.channelId] = f.openLive;
    if (!wasLive && f.openLive) transitions.push(f);
  }
  await chrome.storage.local.set({ [STATE_KEY]: newStates });
  for (const t of transitions) await fireNotification(t);
}

async function fireNotification(ch) {
  const tabs = await chrome.tabs.query({ url: 'https://chzzk.naver.com/*' });
  for (const t of tabs) {
    chrome.tabs.sendMessage(t.id, { type: 'cc-live-toast', channel: ch }).catch(() => {});
  }
}

// ===== 구독 선물 알림 =====
// /commercial/v1/subscribe/channels 응답을 폴링해서 새 선물 구독이 들어오면 chrome.notifications로 알림
async function fetchSubscribeChannels() {
  const r = await fetch('https://api.chzzk.naver.com/commercial/v1/subscribe/channels', { credentials: 'include', cache: 'no-store' });
  if (!r.ok) return null;
  const j = await r.json();
  return Array.isArray(j?.content) ? j.content : null;
}
function subKey(item) {
  // 같은 채널 + 같은 만료일 = 같은 구독 인스턴스
  return `${item.channelId}|${item.nextPublishYmdt || ''}|${item.tier || ''}`;
}
async function pollSubscriptions(initial) {
  let list;
  try { list = await fetchSubscribeChannels(); } catch (_) { return; }
  if (!list) return;
  const { [SUB_SNAPSHOT_KEY]: snap = {} } = await chrome.storage.local.get(SUB_SNAPSHOT_KEY);
  const newSnap = {};
  const newGifts = [];
  for (const item of list) {
    const k = subKey(item);
    newSnap[k] = { channelId: item.channelId, channelName: item.channelName, isGift: !!item.isGift, tierName: item.tierName, nextPublishYmdt: item.nextPublishYmdt };
    if (item.isGift && !snap[k]) newGifts.push(item);
  }
  await chrome.storage.local.set({ [SUB_SNAPSHOT_KEY]: newSnap });
  if (initial) return; // 첫 실행은 알림 없이 baseline만 저장
  for (const g of newGifts) await fireGiftToast(g);
}

async function fireGiftToast(g) {
  const tabs = await chrome.tabs.query({ url: 'https://chzzk.naver.com/*' });
  for (const t of tabs) {
    chrome.tabs.sendMessage(t.id, { type: 'cc-gift-toast', gift: g }).catch(() => {});
  }
}
