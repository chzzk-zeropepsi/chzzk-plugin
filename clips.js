// CHZZK Companion - 클립 다운로드
// /clips/{uid} 페이지에서 mp4 직접 다운로드

(function () {
  const CLIP_RE = /\/clips\/([^/?#]+)/;
  const CHANNEL_CLIPS_RE = /^\/([a-f0-9]{32})\/clips/;
  const clipCache = new Map(); // uid -> { videoId, title, recId, channelId }

  // 페이지 컨텍스트에 fetch 후킹 스크립트 주입 (chzzk 페이지네이션 응답 캡처)
  try {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('inject_clips.js');
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  } catch (_) {}

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.source !== 'cc-clip-list') return;
    for (const it of (e.data.data || [])) {
      if (!it.clipUID) continue;
      clipCache.set(it.clipUID, it);
    }
    if (channelClipsId()) injectOverlayButtons();
  });

  function clipUid() {
    const m = location.pathname.match(CLIP_RE);
    return m ? m[1] : null;
  }

  function channelClipsId() {
    const m = location.pathname.match(CHANNEL_CLIPS_RE);
    return m ? m[1] : null;
  }

  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function findSeedMediaIdFromPerformance() {
    try {
      const entries = performance.getEntriesByType('resource') || [];
      for (let i = entries.length - 1; i >= 0; i--) {
        const u = entries[i].name || '';
        if (!u.includes('creatorhub-api.naver.com') || !u.includes('clipviewer/card')) continue;
        const m = u.match(/seedMediaId=([A-Z0-9]+)/);
        if (m) return m[1];
      }
    } catch (_) {}
    return null;
  }

  function findMp4FromPerformance(mediaId) {
    try {
      const entries = performance.getEntriesByType('resource') || [];
      for (let i = entries.length - 1; i >= 0; i--) {
        const u = entries[i].name || '';
        if (!/\.mp4(\?|$)/i.test(u)) continue;
        if (!u.includes('glive-clip')) continue;
        if (mediaId && !u.includes(mediaId)) continue;
        return u;
      }
    } catch (_) {}
    return null;
  }

  async function fetchClipMeta(uid) {
    const cached = clipCache.get(uid);
    let mediaId = cached?.videoId || findSeedMediaIdFromPerformance();
    if (!mediaId) throw new Error('seedMediaId 미발견 (캐시 미존재 + 페이지 재생 기록 없음)');
    const recIdRaw = cached?.recId || JSON.stringify({ seedClipUID: uid, fromType: 'GLOBAL', listType: 'RECOMMEND' });
    const recId = encodeURIComponent(recIdRaw);
    const referer = encodeURIComponent(`https://chzzk.naver.com/clips/${uid}`);
    const url = `https://creatorhub-api.naver.com/api/v5.0/clipviewer/card?userInteraction=true&seedType=SPECIFIC&serviceType=CHZZK&seedMediaId=${mediaId}&mediaType=SHORT_FORM&panelType=sdk_chzzk&referer=${referer}&recType=CHZZK&recId=${recId}&enableReverse=false&adAllowed=true&deviceType=html5_mo&profileOverride=false`;
    const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
    if (!res.ok) throw new Error('clip meta ' + res.status);
    const j = await res.json();
    const content = j?.body?.card?.content;
    if (!content) throw new Error('응답에 card.content 없음');
    if (content.contentId && content.contentId !== uid) throw new Error(`잘못된 클립: 요청 ${uid}, 응답 ${content.contentId}`);
    return content;
  }

  function extractMp4(playback) {
    const adapts = playback?.MPD?.[0]?.Period?.[0]?.AdaptationSet || [];
    let best = null;
    for (const a of adapts) {
      if (a['@mimeType'] !== 'video/mp4') continue;
      for (const rep of a.Representation || []) {
        const url = rep?.BaseURL?.[0];
        if (!url || !url.includes('.mp4')) continue;
        const h = parseInt(rep['@height']) || 0;
        if (!best || h > best.h) best = { url, h, w: parseInt(rep['@width']) || 0 };
      }
    }
    return best;
  }

  function sanitize(name) {
    return String(name || '').replace(/[\\/:*?"<>|\n\r\t]+/g, '_').slice(0, 120).trim() || 'clip';
  }

  function findActiveVideoMp4() {
    const videos = [...document.querySelectorAll('video')].filter((v) => v.offsetParent && (v.currentSrc || v.src));
    for (const v of videos) {
      const src = v.currentSrc || v.src;
      if (src && /\.mp4(\?|$)/i.test(src)) return src;
    }
    return null;
  }

  function pageTitle(uid) {
    const m = document.title?.match(/^(.*?)\s*[-|·]\s*/);
    return (m ? m[1] : document.title || uid).trim();
  }

  let busy = false;
  async function downloadClip(uid, btn) {
    if (busy) return;
    busy = true;
    const orig = btn.textContent;
    btn.textContent = '⋯ 받는 중';
    btn.disabled = true;
    try {
      let url = '', channelName = '', title = '';
      try {
        const content = await fetchClipMeta(uid);
        const mp4 = extractMp4(content.vod?.playback);
        if (mp4) {
          url = mp4.url;
          channelName = content.channel?.channelName || '';
          title = content.title || '';
        }
      } catch (_) {}
      if (!url) {
        const mid = findSeedMediaIdFromPerformance();
        url = findMp4FromPerformance(mid) || findActiveVideoMp4();
        if (!url) throw new Error('mp4 URL을 얻을 수 없음 (페이지에서 클립 재생 후 다시 시도)');
        title = pageTitle(uid);
      }
      const filename = `${channelName ? sanitize(channelName) + '_' : ''}${sanitize(title)}_${uid}.mp4`;
      await chrome.runtime.sendMessage({ type: 'cc-download', url, filename });
      btn.textContent = '✓ 다운로드';
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; busy = false; }, 1500);
    } catch (e) {
      alert('클립 다운로드 실패: ' + e.message);
      btn.textContent = orig; btn.disabled = false; busy = false;
    }
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

  async function injectButton() {
    const uid = clipUid();
    if (!uid) return;
    await waitForPanel();
    const header = document.querySelector('#cc-followings-panel .cc-fp-header');
    if (!header) return;
    if (header.querySelector('#cc-clip-dl-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'cc-clip-dl-btn';
    btn.type = 'button';
    btn.title = '클립 다운로드';
    btn.textContent = '🎬 다운로드';
    const refreshBtn = header.querySelector('.cc-fp-refresh');
    header.insertBefore(btn, refreshBtn);
    btn.addEventListener('click', () => downloadClip(clipUid() || uid, btn));
  }

  function cleanup() {
    document.getElementById('cc-clip-dl-btn')?.remove();
  }

  async function fetchChannelClipList(channelId, opts = {}) {
    const params = new URLSearchParams({
      clipUID: '', filterType: opts.filterType || 'ALL',
      orderType: opts.orderType || 'POPULAR',
      size: String(opts.size || 30), readCount: '',
    });
    const url = `https://api.chzzk.naver.com/service/v1/channels/${channelId}/clips?${params.toString()}`;
    const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
    if (!res.ok) throw new Error('clip list ' + res.status);
    const j = await res.json();
    return j?.content?.data || [];
  }

  async function loadChannelClipsIntoCache(channelId) {
    try {
      const items = await fetchChannelClipList(channelId);
      for (const it of items) {
        if (!it.clipUID) continue;
        clipCache.set(it.clipUID, {
          videoId: it.videoId,
          title: it.clipTitle,
          recId: it.recId,
          channelId: it.ownerChannelId,
        });
      }
    } catch (_) {}
  }

  function injectOverlayButtons(rootScope) {
    const links = (rootScope || document).querySelectorAll('a[href*="/clips/"]');
    for (const a of links) {
      const m = a.getAttribute('href')?.match(CLIP_RE);
      if (!m) continue;
      const uid = m[1];
      if (a.querySelector('.cc-clip-dl-overlay')) continue;
      const cs = getComputedStyle(a);
      if (cs.position === 'static') a.style.position = 'relative';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cc-clip-dl-overlay';
      btn.title = '클립 다운로드';
      btn.textContent = '⬇';
      btn.addEventListener('click', async (e) => {
        e.preventDefault(); e.stopPropagation();
        await downloadClip(uid, btn);
      });
      a.appendChild(btn);
    }
  }

  let listObserver = null;
  function startListMode(channelId) {
    loadChannelClipsIntoCache(channelId).then(() => injectOverlayButtons());
    listObserver?.disconnect();
    listObserver = new MutationObserver(() => injectOverlayButtons());
    listObserver.observe(document.body, { childList: true, subtree: true });
  }
  function stopListMode() {
    listObserver?.disconnect();
    listObserver = null;
    document.querySelectorAll('.cc-clip-dl-overlay').forEach((b) => b.remove());
  }

  function refreshForPath() {
    cleanup();
    stopListMode();
    if (clipUid()) injectButton();
    const cid = channelClipsId();
    if (cid) startListMode(cid);
  }

  refreshForPath();

  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    refreshForPath();
  }, 1500);
})();
