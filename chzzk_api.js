// CHZZK Companion - chzzk public API helpers
// 호출은 chzzk.naver.com 쿠키가 필요하므로 host_permissions와 credentials:include 사용

const BASE = 'https://api.chzzk.naver.com';

function bgFetchJson(url) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'cc-fetch-json', url }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (res?.error) return reject(new Error(res.error));
      resolve(res?.data);
    });
  });
}

export async function fetchFollowings({ size = 100, maxPages = 20 } = {}) {
  const all = [];
  for (let page = 0; page < maxPages; page++) {
    const url = `${BASE}/service/v1/channels/followings?page=${page}&size=${size}&sortType=FOLLOW`;
    const j = await bgFetchJson(url);
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
  return all.map(normalizeFollowing).filter((x) => x.channelId && !seen.has(x.channelId) && (seen.add(x.channelId), true));
}

function normalizeFollowing(item) {
  const ch = item?.channel ?? item;
  return {
    channelId: ch?.channelId || '',
    channelName: ch?.channelName || '',
    channelImageUrl: ch?.channelImageUrl || '',
    openLive: !!(ch?.openLive ?? item?.openLive),
    liveCategory: ch?.personalData?.privateUserBlock ? '' : (item?.streamer?.openLive ? '' : ''),
  };
}

export async function fetchLiveStatus(channelId) {
  const url = `${BASE}/polling/v2/channels/${channelId}/live-status`;
  const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
  if (!res.ok) return null;
  const j = await res.json();
  return j?.content ?? null;
}
