// CHZZK Companion - page-context fetch/XHR interceptor
(function () {
  if (window.__ccClipsHooked) return;
  window.__ccClipsHooked = true;

  const LIST_RE = /api\.chzzk\.naver\.com\/service\/v[12]\/channels\/[a-zA-Z0-9]+\/clips/;
  const VIDEO_LIST_RE = /api\.chzzk\.naver\.com\/service\/v[12]\/channels\/[a-zA-Z0-9]+\/videos/;
  const VIDEO_DETAIL_RE = /api\.chzzk\.naver\.com\/service\/v[23]\/videos\/[0-9]+/;

  const send = (data) => {
    try { window.postMessage({ source: 'cc-clip-list', data }, '*'); } catch (_) {}
  };
  const handlePayload = (j, url) => {
    if (LIST_RE.test(url)) {
      const data = j?.content?.data || [];
      if (!data.length) return;
      try { window.postMessage({ source: 'cc-clip-list', data: data.map((it) => ({
        clipUID: it.clipUID, videoId: it.videoId, title: it.clipTitle,
        recId: it.recId, channelId: it.ownerChannelId,
      })) }, '*'); } catch (_) {}
    } else if (VIDEO_LIST_RE.test(url)) {
      const data = j?.content?.data || [];
      if (!data.length) return;
      try { window.postMessage({ source: 'cc-video-list', data: data.map((v) => ({
        videoNo: v.videoNo, videoId: v.videoId, title: v.videoTitle,
        duration: v.duration, thumbnailImageUrl: v.thumbnailImageUrl,
        channelName: v.channel?.channelName,
      })) }, '*'); } catch (_) {}
    } else if (VIDEO_DETAIL_RE.test(url)) {
      const c = j?.content || {};
      if (!c.videoNo) return;
      try { window.postMessage({ source: 'cc-video-detail', data: {
        videoNo: c.videoNo, videoId: c.videoId, inKey: c.inKey,
        title: c.videoTitle, duration: c.duration,
        thumbnailImageUrl: c.thumbnailImageUrl,
        channelName: c.channel?.channelName,
      } }, '*'); } catch (_) {}
    }
  };

  // fetch hook
  const origFetch = window.fetch.bind(window);
  window.fetch = async function (...args) {
    const res = await origFetch(...args);
    try {
      const url = (typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url)) || '';
      if (LIST_RE.test(url) || VIDEO_LIST_RE.test(url) || VIDEO_DETAIL_RE.test(url)) {
        res.clone().json().then((j) => handlePayload(j, url)).catch(() => {});
      }
    } catch (_) {}
    return res;
  };

  // XHR hook
  const OrigXHR = window.XMLHttpRequest;
  const OrigOpen = OrigXHR.prototype.open;
  const OrigSend = OrigXHR.prototype.send;
  OrigXHR.prototype.open = function (method, url, ...rest) {
    this.__ccUrl = url;
    return OrigOpen.call(this, method, url, ...rest);
  };
  OrigXHR.prototype.send = function (...args) {
    if (this.__ccUrl && (LIST_RE.test(this.__ccUrl) || VIDEO_LIST_RE.test(this.__ccUrl) || VIDEO_DETAIL_RE.test(this.__ccUrl))) {
      this.addEventListener('load', () => {
        try {
          const j = JSON.parse(this.responseText);
          handlePayload(j, this.__ccUrl);
        } catch (_) {}
      });
    }
    return OrigSend.apply(this, args);
  };

})();
