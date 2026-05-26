// CHZZK Companion - background service worker
// 알림 대상 채널의 라이브 전환(off->on) 감지

const ALARM_NAME = 'cc-notify-poll';
const POLL_PERIOD_MIN = 1;
const NOTIFY_KEY = 'notify_channels';
const STATE_KEY = 'notify_states';

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_PERIOD_MIN });
});
chrome.runtime.onStartup?.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_PERIOD_MIN });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) pollLiveTransitions().catch(() => {});
});

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
  if (msg?.type === 'cc-download') {
    chrome.downloads.download({ url: msg.url, filename: msg.filename, saveAs: false })
      .then((id) => sendResponse({ ok: true, id }))
      .catch((e) => sendResponse({ error: String(e.message ?? e) }));
    return true;
  }
  return false;
});

async function seedChannelState(channelId) {
  if (!channelId) return { ok: false };
  let openLive = null;
  try {
    const res = await fetch(`https://api.chzzk.naver.com/polling/v2/channels/${encodeURIComponent(channelId)}/live-status`, { credentials: 'include', cache: 'no-store' });
    if (res.ok) {
      const j = await res.json();
      const c = j?.content ?? {};
      openLive = c.status ? c.status === 'OPEN' : !!c.openLive;
    }
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
