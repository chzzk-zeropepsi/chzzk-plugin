// CHZZK Companion - HLS manifest + 세그먼트 응답 캡처
// 페이지 컨텍스트에서 fetch/XHR을 후킹해 player의 청크 응답을 가로채서 content script에 전달.
(function () {
  if (window.__ccRewindHooked) return;
  window.__ccRewindHooked = true;

  const MASTER_RE = /\/[A-Za-z0-9_-]+_playlist\.m3u8/;
  const CHUNKLIST_RE = /\/[A-Za-z0-9_-]+_chunklist\.m3u8/;
  const SEG_RE = /\/chzzk\/[^?#]*\.(?:m4s|m4v|ts)(?:\?|$)/;

  let recActive = false;

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (e.data?.type === 'cc-rec-set') {
      recActive = !!e.data.active;
      console.log('[cc-hook] recActive =', recActive);
    }
  });

  function notify(msg, transfer) {
    try {
      if (transfer && transfer.length) window.postMessage(msg, '*', transfer);
      else window.postMessage(msg, '*');
    } catch (_) {}
  }

  function handleResponse(url, resp) {
    if (!resp || !resp.ok) return;
    if (MASTER_RE.test(url)) {
      notify({ source: 'cc-rewind-manifest', url, ts: Date.now() });
    }
    if (CHUNKLIST_RE.test(url)) {
      notify({ source: 'cc-live-chunklist-url', url, ts: Date.now() });
      // 항상 chunklist 본문도 같이 보내서 segment URL 누적용으로 사용
      resp.clone().text().then((t) => {
        notify({ source: 'cc-live-chunklist-text', baseUrl: url, text: t, ts: Date.now() });
      }).catch(() => {});
    }
    if (SEG_RE.test(url)) {
      // 토큰 추출용 URL 전달 (data는 아님)
      notify({ source: 'cc-live-seg-url', url, ts: Date.now() });
    }
    if (!recActive) return;
    if (SEG_RE.test(url)) {
      resp.clone().arrayBuffer().then((buf) => {
        notify({ source: 'cc-rec-chunk', url, buf });
      }).catch(() => {});
    } else if (CHUNKLIST_RE.test(url)) {
      resp.clone().text().then((t) => {
        const dur = {};
        const lines = t.split(/\r?\n/);
        let pending = 0;
        for (const raw of lines) {
          const l = raw.trim();
          if (l.startsWith('#EXTINF')) pending = parseFloat(l.split(':')[1]) || 0;
          else if (l && !l.startsWith('#')) { dur[l] = pending; pending = 0; }
        }
        notify({ source: 'cc-rec-chunklist', baseUrl: url, dur, endlist: t.includes('#EXT-X-ENDLIST') });
      }).catch(() => {});
    }
  }

  const _fetch = window.fetch;
  window.fetch = function (input, init) {
    const u = typeof input === 'string' ? input : (input && input.url);
    const p = _fetch.apply(this, arguments);
    if (u && (MASTER_RE.test(u) || CHUNKLIST_RE.test(u) || (recActive && SEG_RE.test(u)))) {
      p.then((r) => handleResponse(u, r)).catch(() => {});
    }
    return p;
  };

  const XO = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ccUrl = url;
    if (url && MASTER_RE.test(url)) notify({ source: 'cc-rewind-manifest', url, ts: Date.now() });
    if (url && CHUNKLIST_RE.test(url)) notify({ source: 'cc-live-chunklist-url', url, ts: Date.now() });
    if (url && SEG_RE.test(url)) notify({ source: 'cc-live-seg-url', url, ts: Date.now() });
    return XO.apply(this, arguments);
  };
  const XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    const url = this.__ccUrl;
    if (url && (CHUNKLIST_RE.test(url) || (recActive && SEG_RE.test(url)))) {
      this.addEventListener('load', async () => {
        if (this.status < 200 || this.status >= 300) return;
        try {
          if (SEG_RE.test(url) && recActive) {
            let buf = null;
            const r = this.response;
            if (r instanceof ArrayBuffer) buf = r;
            else if (r instanceof Blob) buf = await r.arrayBuffer();
            else if (typeof r === 'string') {
              const u8 = new Uint8Array(r.length);
              for (let i = 0; i < r.length; i++) u8[i] = r.charCodeAt(i) & 0xff;
              buf = u8.buffer;
            }
            if (buf) notify({ source: 'cc-rec-chunk', url, buf });
          } else if (CHUNKLIST_RE.test(url) && typeof this.responseText === 'string') {
            handleResponse(url, new Response(this.responseText, { status: 200 }));
          }
        } catch (_) {}
      });
    }
    return XS.apply(this, arguments);
  };
})();
