// CHZZK Companion - 다중 채널 라이브 시청
(async function () {

  const LIVE_RE = /^\/live\/([^/?#]+)/;
  const ACCUM_STORAGE_PREFIX = 'cc_accum_';

  // 이전 버전이 저장한 storage 키들 정리 (더 이상 사용 안 함)
  (async () => {
    try {
      const all = await chrome.storage.local.get(null);
      const toRemove = Object.keys(all).filter((k) => k.startsWith(ACCUM_STORAGE_PREFIX) || k === 'cc_active_recordings');
      if (toRemove.length) await chrome.storage.local.remove(toRemove);
    } catch (_) {}
  })();

  let ctxInvalid = false;

  async function bgFetchText(url) {
    // content script에서 직접 fetch — chzzk.naver.com 페이지의 Referer 사용 가능 (CDN 통과율 높음)
    try {
      const r = await fetch(url, { credentials: 'omit', cache: 'no-store' });
      if (!r.ok) {
        const err = new Error('http ' + r.status);
        err.status = r.status;
        err.url = url;
        throw err;
      }
      return await r.text();
    } catch (e) {
      if (e.status) throw e;
      // CORS 등 fetch 실패 → background fallback
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'cc-bg-fetch-text', url }, (res) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!res || !res.ok) {
            const err = new Error('http ' + (res?.status || res?.error || '?'));
            err.status = res?.status;
            err.url = url;
            return reject(err);
          }
          resolve(res.text);
        });
      });
    }
  }
  // Firefox는 background에서 blob URL을 다운로드할 수 없으므로 content script에서 직접 anchor click
  // 다른 content script 파일(예: clips.js)에서도 쓰도록 window에 노출
  function triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 5000);
  }
  window.ccTriggerBlobDownload = triggerBlobDownload;
  async function bgFetchBin(url) {
    try {
      const r = await fetch(url, { credentials: 'omit', cache: 'no-store' });
      if (!r.ok) {
        const err = new Error('http ' + r.status);
        err.status = r.status;
        err.url = url;
        throw err;
      }
      return await r.arrayBuffer();
    } catch (e) {
      if (e.status) throw e;
      // fetch 실패 시 background fallback
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'cc-bg-fetch-bin', url }, (res) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!res || !res.ok) {
            const err = new Error('http ' + (res?.status || res?.error || '?'));
            err.status = res?.status;
            err.url = url;
            return reject(err);
          }
          const bin = atob(res.b64);
          const buf = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
          resolve(buf.buffer);
        });
      });
    }
  }

  function liveCid() {
    const m = location.pathname.match(LIVE_RE);
    return m ? m[1] : null;
  }

  // ===== 다중 채널 시청 (MVP) =====
  // 다른 채널의 라이브 스트림을 별도 패널로 띄움




  // 라이브 중인 팔로잉 채널 선택 picker
  // 한글 초성 추출 (검색용)
  function toInitials(s) {
    const cho = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
    let out = '';
    for (const ch of String(s || '')) {
      const code = ch.charCodeAt(0);
      if (code >= 0xAC00 && code <= 0xD7A3) {
        out += cho[Math.floor((code - 0xAC00) / 588)];
      } else {
        out += ch.toLowerCase();
      }
    }
    return out;
  }
  function matchChannel(it, q) {
    if (!q) return true;
    const ql = q.toLowerCase();
    if (it.name.toLowerCase().includes(ql)) return true;
    if (/^[ㄱ-ㅎ]+$/.test(q)) {
      if (toInitials(it.name).includes(q)) return true;
    }
    return false;
  }
  // chzzk 본 페이지를 iframe으로 띄움 — player + chat + UI 그대로
  async function openSecondaryPanel(cid) {
    const existId = 'cc-cp2-overlay-' + cid;
    const existing = document.getElementById(existId);
    if (existing) { existing.style.zIndex = String(Date.now()); return; }

    // 채널 이름 비동기 조회용
    let channelName = cid.slice(0, 8);
    fetch(`https://api.chzzk.naver.com/service/v1/channels/${cid}`, { credentials: 'include', cache: 'no-store' })
      .then((r) => r.json()).then((j) => {
        const n = j?.content?.channelName;
        if (n) { channelName = n; const lab = overlay.querySelector('.cc-cp2-channel'); if (lab) lab.textContent = `📺 ${n}`; }
      }).catch(() => {});

    const overlay = document.createElement('div');
    overlay.id = existId;
    overlay.style.cssText = 'position:fixed;right:20px;bottom:20px;width:520px;height:340px;background:#000;border:2px solid #1AE192;border-radius:8px;z-index:999998;box-shadow:0 8px 30px rgba(0,0,0,0.8);display:flex;flex-direction:column;overflow:hidden;resize:both;min-width:320px;min-height:240px;';
    overlay.innerHTML = `
      <div class="cc-cp2-head" style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:#1a1a1a;cursor:move;flex-shrink:0;">
        <span class="cc-cp2-channel" style="color:#1AE192;font-weight:700;font-size:11px;">📺 ${cid.slice(0,8)}…</span>
        <div style="display:flex;gap:6px;">
          <button class="cc-cp2-chat" title="채팅 토글" style="background:transparent;border:1px solid #555;color:#ccc;border-radius:3px;padding:3px 6px;cursor:pointer;font-size:11px;">💬</button>
          <button class="cc-cp2-pip" title="PiP (브라우저 분리)" style="background:transparent;border:1px solid #555;color:#ccc;border-radius:3px;padding:3px 6px;cursor:pointer;font-size:11px;">⧉</button>
          <button class="cc-cp2-close" style="background:#e04545;color:#fff;border:none;border-radius:3px;padding:3px 8px;cursor:pointer;font-size:10px;">✕</button>
        </div>
      </div>
      <div class="cc-cp2-main" style="flex:1;display:flex;min-height:0;">
        <div class="cc-cp2-body" style="flex:1;position:relative;background:#000;overflow:hidden;min-width:0;">
          <video class="cc-cp2-mirror" autoplay playsinline muted style="width:100%;height:100%;display:block;background:#000;object-fit:contain;"></video>
          <div class="cc-cp2-status" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);color:#888;font-size:12px;pointer-events:none;">로딩 중…</div>
          <iframe class="cc-cp2-iframe" src="https://chzzk.naver.com/live/${encodeURIComponent(cid)}" style="position:absolute;left:-99999px;top:0;width:640px;height:360px;border:none;pointer-events:none;" allow="autoplay; encrypted-media"></iframe>
        </div>
        <div class="cc-cp2-chat-wrap" style="display:none;flex-direction:column;width:340px;flex-shrink:0;border-left:1px solid #333;background:#0f0f12;min-height:0;resize:horizontal;overflow:auto;min-width:240px;max-width:600px;">
          <iframe class="cc-cp2-chat-iframe" style="flex:1;width:100%;border:none;background:#0f0f12;display:block;min-height:0;"></iframe>
        </div>
      </div>
      <div class="cc-cp2-ctrl" style="display:flex;align-items:center;gap:6px;padding:5px 8px;background:#1a1a1a;flex-shrink:0;border-top:1px solid #333;">
        <button class="cc-cp2-play" title="재생/일시정지" style="background:#1AE192;color:#111;border:none;border-radius:3px;padding:3px 8px;cursor:pointer;font-weight:700;font-size:11px;width:30px;">▶</button>
        <button class="cc-cp2-mute" title="음소거" style="background:transparent;border:1px solid #555;color:#ccc;border-radius:3px;padding:3px 6px;cursor:pointer;font-size:11px;width:30px;">🔇</button>
        <input class="cc-cp2-vol" type="range" min="0" max="100" value="60" style="flex:1;height:4px;cursor:pointer;">
      </div>
    `;
    document.body.appendChild(overlay);
    enableOverlayDrag(overlay, overlay.querySelector('.cc-cp2-head'));
    let syncIv = null;
    overlay.querySelector('.cc-cp2-close').addEventListener('click', () => { if (syncIv) clearInterval(syncIv); overlay.remove(); });

    const iframe = overlay.querySelector('.cc-cp2-iframe');
    const playBtn = overlay.querySelector('.cc-cp2-play');
    const muteBtn = overlay.querySelector('.cc-cp2-mute');
    const volEl = overlay.querySelector('.cc-cp2-vol');
    const getVideo = () => { try { return iframe.contentDocument?.querySelector('video.webplayer-internal-video, video'); } catch (_) { return null; } };

    const mirror = overlay.querySelector('.cc-cp2-mirror');

    overlay.querySelector('.cc-cp2-pip').addEventListener('click', async () => {
      try { if (document.pictureInPictureEnabled) await mirror.requestPictureInPicture(); }
      catch (e) { console.warn('[cc-cp2] PiP fail', e); }
    });
    const chatBtn = overlay.querySelector('.cc-cp2-chat');
    const chatWrap = overlay.querySelector('.cc-cp2-chat-wrap');
    const chatFrame = overlay.querySelector('.cc-cp2-chat-iframe');
    // 채팅 iframe에 주입할 컴팩트 CSS
    function injectChatCompactCss() {
      try {
        const doc = chatFrame.contentDocument;
        if (!doc) return false;
        if (doc.getElementById('cc-cp2-chat-compact')) return true;
        const css = doc.createElement('style');
        css.id = 'cc-cp2-chat-compact';
        css.textContent = `
          html, body { width:100% !important; height:100% !important; margin:0 !important; padding:0 !important; background:#0f0f12 !important; overflow:hidden !important; }
          body > * { height:100% !important; }
        `;
        doc.head.appendChild(css);
        return true;
      } catch (_) { return false; }
    }

    chatBtn.addEventListener('click', () => {
      const willOpen = chatWrap.style.display === 'none';
      chatWrap.style.display = willOpen ? 'flex' : 'none';
      chatBtn.style.background = willOpen ? '#1AE192' : 'transparent';
      chatBtn.style.color = willOpen ? '#111' : '#ccc';
      if (willOpen && !chatFrame.src) {
        chatFrame.src = `https://chzzk.naver.com/live/${encodeURIComponent(cid)}/chat`;
        chatFrame.addEventListener('load', () => {
          // SPA가 DOM을 갱신해도 다시 주입되도록 주기적으로 시도
          let tries = 0;
          const t = setInterval(() => { injectChatCompactCss(); if (++tries > 30) clearInterval(t); }, 500);
        });
      }
      if (willOpen) {
        const cur = overlay.getBoundingClientRect().width;
        if (cur < 700) overlay.style.width = '820px';
      }
    });
    playBtn.addEventListener('click', () => {
      const src = getVideo();
      if (mirror.paused) {
        try { mirror.play(); } catch (_) {}
        if (src && src.paused) { try { src.play(); } catch (_) {} }
      } else {
        mirror.pause();
        if (src) src.pause();
      }
    });
    muteBtn.addEventListener('click', () => {
      mirror.muted = !mirror.muted;
    });
    volEl.addEventListener('input', () => {
      mirror.volume = parseInt(volEl.value) / 100;
      if (mirror.volume > 0) mirror.muted = false;
    });

    function syncControls() {
      playBtn.textContent = mirror.paused ? '▶' : '⏸';
      muteBtn.textContent = mirror.muted || mirror.volume === 0 ? '🔇' : '🔊';
    }
    syncIv = setInterval(syncControls, 500);

    // iframe 내부 video의 stream을 mirror에 흘려보냄 — 영상만 분리해서 표시
    const status = overlay.querySelector('.cc-cp2-status');
    let mirrored = false;
    function tryMirror() {
      if (mirrored) return true;
      const v = getVideo();
      if (!v || v.readyState < 2 || typeof v.captureStream !== 'function') return false;
      try {
        mirror.srcObject = v.captureStream();
        mirror.muted = true; // autoplay 정책: 처음엔 muted, 사용자가 🔇 클릭으로 음소거 해제
        mirror.play().catch(() => {});
        v.muted = true; // 원본은 음소거 (중복 오디오 방지)
        v.volume = 1;
        mirrored = true;
        if (status) status.style.display = 'none';
        return true;
      } catch (e) { console.warn('[cc-cp2] mirror fail', e); return false; }
    }
    iframe.addEventListener('load', () => {
      let tries = 0;
      const t = setInterval(() => { if (tryMirror() || ++tries > 60) clearInterval(t); }, 500);
    });
  }

  async function openChannelPicker() {
    document.getElementById('cc-cp-picker')?.remove();
    const picker = document.createElement('div');
    picker.id = 'cc-cp-picker';
    picker.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:360px;max-height:70vh;display:flex;flex-direction:column;background:#1e1e24;border:2px solid #1AE192;border-radius:8px;z-index:1000000;color:#eee;padding:12px;box-shadow:0 8px 30px rgba(0,0,0,0.8);';
    picker.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-shrink:0;">
        <span style="font-weight:700;color:#1AE192;">📺 다른 채널 추가</span>
        <button id="cc-cp-picker-close" style="background:transparent;border:none;color:#aaa;cursor:pointer;font-size:16px;">✕</button>
      </div>
      <input id="cc-cp-picker-search" type="text" placeholder="채널 이름 / 초성 검색" style="background:#2a2a32;border:1px solid #444;color:#eee;border-radius:4px;padding:6px 10px;font-size:12px;outline:none;margin-bottom:8px;flex-shrink:0;">
      <div id="cc-cp-picker-list" style="overflow-y:auto;flex:1;font-size:12px;min-height:0;">로딩 중...</div>
    `;
    document.body.appendChild(picker);
    picker.querySelector('#cc-cp-picker-close').addEventListener('click', () => picker.remove());
    const searchEl = picker.querySelector('#cc-cp-picker-search');
    const listEl = picker.querySelector('#cc-cp-picker-list');
    let items = [];
    function render(q) {
      const filtered = items.filter((it) => matchChannel(it, q));
      if (!filtered.length) { listEl.textContent = q ? '일치 채널 없음' : '팔로잉 채널 없음'; return; }
      listEl.innerHTML = filtered.map((it) => `
        <div data-cid="${it.cid}" data-live="${it.live}" class="cc-cp-pick-row" style="display:flex;align-items:center;gap:8px;padding:6px;cursor:${it.live ? 'pointer' : 'not-allowed'};border-radius:4px;opacity:${it.live ? '1' : '0.45'};">
          ${it.img ? `<img src="${it.img}" style="width:24px;height:24px;border-radius:50%;">` : ''}
          <span style="flex:1;">${it.name}</span>
          ${it.live
            ? `<span style="display:inline-flex;align-items:center;gap:3px;background:#e04545;color:#fff;font-size:9px;font-weight:700;padding:2px 5px;border-radius:3px;">● LIVE</span>`
            : `<span style="color:#666;font-size:10px;">오프라인</span>`}
        </div>`).join('');
      listEl.querySelectorAll('.cc-cp-pick-row').forEach((row) => {
        if (row.dataset.live !== 'true') return;
        row.addEventListener('mouseenter', () => row.style.background = '#2a2a32');
        row.addEventListener('mouseleave', () => row.style.background = '');
        row.addEventListener('click', () => { picker.remove(); openSecondaryPanel(row.dataset.cid); });
      });
    }
    searchEl.addEventListener('input', () => render(searchEl.value.trim()));
    searchEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') picker.remove();
      if (e.key === 'Enter') {
        const first = listEl.querySelector('.cc-cp-pick-row[data-live="true"]');
        if (first) { picker.remove(); openSecondaryPanel(first.dataset.cid); }
      }
    });
    setTimeout(() => searchEl.focus(), 50);
    try {
      const r = await fetch('https://api.chzzk.naver.com/service/v1/channels/followings/live?size=200', { credentials: 'include', cache: 'no-store' });
      const j = await r.json();
      const list = j?.content?.followingList || j?.content?.data || [];
      items = list.map((x) => {
        const ch = x.channel || x.streamer?.channel || x;
        return {
          cid: ch.channelId,
          name: ch.channelName,
          img: ch.channelImageUrl || '',
          live: !!(x.streamer?.openLive || x.openLive || ch.openLive),
        };
      }).filter((it) => it.cid);
      items.sort((a, b) => (b.live - a.live) || a.name.localeCompare(b.name, 'ko'));
      render('');
    } catch (e) {
      listEl.textContent = '❌ ' + e.message;
    }
  }

  // debug 노출
  window.__ccAddPanel = openSecondaryPanel;
  window.__ccPickPanel = openChannelPicker;

  function enableOverlayDrag(overlay, handle) {
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      const rect = overlay.getBoundingClientRect();
      const ox = e.clientX - rect.left;
      const oy = e.clientY - rect.top;
      const move = (ev) => {
        overlay.style.left = (ev.clientX - ox) + 'px';
        overlay.style.top = (ev.clientY - oy) + 'px';
        overlay.style.right = 'auto';
        overlay.style.bottom = 'auto';
        overlay.style.transform = 'none';
      };
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      e.preventDefault();
    });
  }
  // inject_rewind.js (MAIN world) → chat WebSocket 후킹 + 메시지 전송
  function sendChatMessage(text) {
    return new Promise((resolve) => {
      if (!text || !text.trim()) return resolve({ ok: false, error: '빈 메시지' });
      const reqId = Math.random().toString(36).slice(2);
      const onMsg = (e) => {
        if (e.source !== window) return;
        if (e.data?.source !== 'cc-chat-send-res' || e.data.reqId !== reqId) return;
        window.removeEventListener('message', onMsg);
        resolve(e.data);
      };
      window.addEventListener('message', onMsg);
      window.postMessage({ source: 'cc-chat-send-req', reqId, text }, '*');
      setTimeout(() => { window.removeEventListener('message', onMsg); resolve({ ok: false, error: '응답 시간 초과' }); }, 3000);
    });
  }
  function chatStatus() {
    return new Promise((resolve) => {
      const reqId = Math.random().toString(36).slice(2);
      const onMsg = (e) => {
        if (e.source !== window || e.data?.source !== 'cc-chat-status-res' || e.data.reqId !== reqId) return;
        window.removeEventListener('message', onMsg);
        resolve(e.data);
      };
      window.addEventListener('message', onMsg);
      window.postMessage({ source: 'cc-chat-status-req', reqId }, '*');
      setTimeout(() => { window.removeEventListener('message', onMsg); resolve({ hasSocket: false, hasTemplate: false }); }, 500);
    });
  }
  function sendChatVertical(text) {
    return new Promise((resolve) => {
      const reqId = Math.random().toString(36).slice(2);
      const onMsg = (e) => {
        if (e.source !== window || e.data?.source !== 'cc-chat-vertical-res' || e.data.reqId !== reqId) return;
        window.removeEventListener('message', onMsg);
        resolve(e.data);
      };
      window.addEventListener('message', onMsg);
      window.postMessage({ source: 'cc-chat-vertical-req', reqId, text }, '*');
      // 세로 보내기는 글자 수만큼 오래 걸릴 수 있어 timeout 길게
      setTimeout(() => { window.removeEventListener('message', onMsg); resolve({ ok: false, error: '응답 시간 초과' }); }, 60000);
    });
  }

  function ensureUi() {
    const cid = liveCid();
    if (!cid) {
      document.getElementById('cc-live-rec-wrap')?.remove();
      return;
    }
    const header = document.querySelector('#cc-followings-panel .cc-fp-header');
    if (!header) return;
    if (header.querySelector('#cc-live-rec-wrap')) return;
    const wrap = document.createElement('span');
    wrap.id = 'cc-live-rec-wrap';
    wrap.style.cssText = 'display:inline-flex;align-items:center;gap:4px;';
    wrap.innerHTML = `
      <button id="cc-multi-btn" type="button" class="cc-icon-btn" title="다른 채널 라이브 추가 시청" style="font-size:13px;">📺</button>
      <button id="cc-chat-btn" type="button" class="cc-icon-btn" title="현재 채널에 채팅 빠른 전송" style="font-size:13px;">💬</button>
    `;
    const row2 = header.querySelector('.cc-fp-row2');
    const refreshBtn = header.querySelector('.cc-fp-refresh');
    if (row2) row2.appendChild(wrap);
    else if (refreshBtn) refreshBtn.parentElement.insertBefore(wrap, refreshBtn);
    else header.appendChild(wrap);
    wrap.querySelector('#cc-multi-btn').addEventListener('click', openChannelPicker);
    wrap.querySelector('#cc-chat-btn').addEventListener('click', openQuickChatBar);
  }

  // 현재 채널에 채팅 빠르게 보내기 UI (작은 floating bar)
  const ALLOWED_VERTICAL_UID = '7b0fcd3edee3b56be1c0233928a8f91a';
  let cachedCurrentUid = null;
  async function fetchCurrentUserIdHash() {
    if (cachedCurrentUid !== null) return cachedCurrentUid;
    try {
      const r = await fetch('https://comm-api.game.naver.com/nng_main/v1/user/getUserStatus', { credentials: 'include', cache: 'no-store' });
      const j = await r.json();
      cachedCurrentUid = j?.content?.userIdHash || '';
    } catch (_) { cachedCurrentUid = ''; }
    return cachedCurrentUid;
  }
  async function fetchChannelName(cid) {
    try {
      const r = await fetch(`https://api.chzzk.naver.com/service/v1/channels/${cid}`, { credentials: 'include', cache: 'no-store' });
      const j = await r.json();
      return {
        name: j?.content?.channelName || '',
        following: !!j?.content?.personalData?.following?.following,
      };
    } catch (_) { return { name: '', following: false }; }
  }
  async function fetchChatPermission(cid) {
    try {
      const r = await fetch(`https://api.chzzk.naver.com/service/v3.3/channels/${cid}/live-detail?cu=true&tm=true`, { credentials: 'include', cache: 'no-store' });
      const j = await r.json();
      const c = j?.content || {};
      return {
        chatAvailableGroup: c.chatAvailableGroup || 'ALL',
        chatAvailableCondition: c.chatAvailableCondition || 'NONE',
        adult: !!c.adult,
        paidPromotion: !!c.paidPromotion,
      };
    } catch (_) { return null; }
  }
  function openQuickChatBar() {
    const cid = liveCid();
    if (!cid) { alert('라이브 채널 페이지에서만 사용 가능'); return; }
    document.getElementById('cc-quick-chat')?.remove();
    const bar = document.createElement('div');
    bar.id = 'cc-quick-chat';
    bar.style.cssText = 'position:fixed;left:50%;bottom:40px;transform:translateX(-50%);width:520px;max-width:90vw;background:#1e1e24;border:2px solid #1AE192;border-radius:8px;padding:8px;z-index:1000001;box-shadow:0 8px 30px rgba(0,0,0,0.8);display:flex;flex-direction:column;gap:6px;';
    bar.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:0 2px;">
        <span id="cc-qc-channel" style="color:#1AE192;font-size:12px;font-weight:700;">📺 ${cid.slice(0,8)}…</span>
        <span style="color:#888;font-size:10px;">현재 라이브 채팅으로 전송</span>
      </div>
      <div style="display:flex;gap:6px;align-items:center;">
        <input type="text" id="cc-qc-input" placeholder="채팅 메시지 입력 후 Enter (Esc 닫기)" style="flex:1;background:#2a2a32;border:1px solid #444;color:#eee;border-radius:4px;padding:6px 10px;font-size:13px;outline:none;">
        <label id="cc-qc-vertical-wrap" style="display:none;color:#ccc;font-size:11px;align-items:center;gap:3px;cursor:pointer;" title="한 글자씩 세로로 보내기">
          <input type="checkbox" id="cc-qc-vertical" style="margin:0;"> 세로
        </label>
        <button id="cc-qc-send" style="background:#1AE192;color:#111;border:none;border-radius:4px;padding:6px 12px;cursor:pointer;font-weight:700;">전송</button>
        <button id="cc-qc-close" style="background:transparent;border:1px solid #555;color:#aaa;border-radius:4px;padding:6px 10px;cursor:pointer;">✕</button>
      </div>
    `;
    document.body.appendChild(bar);
    // 세로 모드는 특정 사용자만 노출
    fetchCurrentUserIdHash().then((uid) => {
      if (uid === ALLOWED_VERTICAL_UID) {
        const wrap = bar.querySelector('#cc-qc-vertical-wrap');
        if (wrap) wrap.style.display = 'flex';
      }
    });
    // 채널 이름 + 권한 체크
    (async () => {
      const [chInfo, perm] = await Promise.all([fetchChannelName(cid), fetchChatPermission(cid)]);
      if (chInfo.name) bar.querySelector('#cc-qc-channel').textContent = `📺 ${chInfo.name}`;
      if (!perm) return;
      const inputEl = bar.querySelector('#cc-qc-input');
      const sendBtn = bar.querySelector('#cc-qc-send');
      let block = null;
      if (perm.chatAvailableGroup === 'FOLLOWER' && !chInfo.following) {
        block = '🔒 팔로워 전용 채팅 — 팔로우 후 사용 가능';
      } else if (perm.chatAvailableGroup === 'MANAGER') {
        block = '🔒 매니저 전용 채팅';
      } else if (perm.chatAvailableCondition === 'REAL_NAME') {
        block = '⚠ 실명 인증 필요한 채팅 (전송 시도는 가능)';
      } else if (perm.chatAvailableCondition === 'MOBILE_VERIFIED') {
        block = '⚠ 휴대폰 인증 필요한 채팅 (전송 시도는 가능)';
      }
      if (block) {
        inputEl.placeholder = block;
        if (block.startsWith('🔒')) {
          inputEl.disabled = true;
          sendBtn.disabled = true;
          sendBtn.style.opacity = '0.4';
          sendBtn.style.cursor = 'not-allowed';
        }
      }
    })();
    const input = bar.querySelector('#cc-qc-input');
    // 템플릿 캡처 상태 안내
    chatStatus().then((s) => {
      if (!s.hasSocket) input.placeholder = '⚠ 채팅 WebSocket 연결 안됨 — 채팅창을 열어주세요';
      else if (!s.hasTemplate) input.placeholder = '⚠ 먼저 평소처럼 채팅을 한 번 직접 보낸 후 사용 가능';
    });
    const status = (msg, color) => {
      let s = bar.querySelector('#cc-qc-status');
      if (!s) { s = document.createElement('div'); s.id = 'cc-qc-status'; s.style.cssText = 'position:absolute;left:0;right:0;top:-22px;text-align:center;font-size:11px;'; bar.appendChild(s); }
      s.style.color = color || '#aaa'; s.textContent = msg;
      setTimeout(() => s?.remove(), 2000);
    };
    const vert = bar.querySelector('#cc-qc-vertical');
    async function send() {
      const text = input.value.trim();
      if (!text) return;
      const isVertical = vert.checked;
      const sendBtn = bar.querySelector('#cc-qc-send');
      sendBtn.disabled = true;
      const oldText = sendBtn.textContent;
      sendBtn.textContent = isVertical ? '세로 보내는 중…' : '전송 중…';
      try {
        const r = isVertical ? await sendChatVertical(text) : await sendChatMessage(text);
        if (r.ok) { input.value = ''; status(isVertical ? `✓ 세로 ${r.sent?.length || 0}자 완료` : '✓ 전송', '#1AE192'); }
        else status('❌ ' + r.error, '#e04545');
      } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = oldText;
      }
    }
    bar.querySelector('#cc-qc-send').addEventListener('click', send);
    bar.querySelector('#cc-qc-close').addEventListener('click', () => bar.remove());
    input.addEventListener('keydown', (e) => {
      // 한글 IME composition 중의 Enter는 무시 (조합 확정용)
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { e.preventDefault(); send(); }
      else if (e.key === 'Escape') bar.remove();
    });
    setTimeout(() => input.focus(), 50);
  }

  const _uiIv = setInterval(() => {
    if (ctxInvalid) { clearInterval(_uiIv); return; }
    ensureUi();
  }, 2000);
  ensureUi();

})();
