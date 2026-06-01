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
  function appendBufAsync(sb, buf) {
    return new Promise((resolve, reject) => {
      const onU = () => { sb.removeEventListener('updateend', onU); sb.removeEventListener('error', onE); resolve(); };
      const onE = () => { sb.removeEventListener('updateend', onU); sb.removeEventListener('error', onE); reject(new Error('sourceBuffer error')); };
      sb.addEventListener('updateend', onU);
      sb.addEventListener('error', onE);
      try { sb.appendBuffer(buf); } catch (e) { sb.removeEventListener('updateend', onU); sb.removeEventListener('error', onE); reject(e); }
    });
  }

  // ===== 다중 채널 시청 (MVP) =====
  // 다른 채널의 라이브 스트림을 별도 패널로 띄움
  async function fetchLiveMasterUrl(cid) {
    // v3.3 + cu/tm 쿼리는 성인 인증된 사용자에게 성인 방송의 livePlaybackJson도 포함해 반환
    const r = await fetch(`https://api.chzzk.naver.com/service/v3.3/channels/${cid}/live-detail?cu=true&tm=true`, { credentials: 'include', cache: 'no-store' });
    if (!r.ok) throw new Error('live-detail ' + r.status);
    const j = await r.json();
    const c = j?.content;
    if (!c) throw new Error('content 없음 (code: ' + j?.code + ')');
    if (!c.livePlaybackJson) {
      if (c.adult) throw new Error('성인 인증이 필요한 방송입니다. 해당 채널 페이지에서 인증한 뒤 다시 시도하세요.');
      throw new Error(`방송 중이 아닙니다 (status: ${c.status || '?'})`);
    }
    const pb = typeof c.livePlaybackJson === 'string' ? JSON.parse(c.livePlaybackJson) : c.livePlaybackJson;
    const media = pb.media?.find((m) => m.mediaId === 'HLS') || pb.media?.[0];
    if (!media?.path) throw new Error('master URL 없음');
    return { masterUrl: media.path, title: c.liveTitle, channelName: c.channel?.channelName };
  }

  function parseMasterVariants(masterText) {
    // master는 #EXT-X-STREAM-INF: RESOLUTION=WxH \n url 패턴
    const lines = masterText.split(/\r?\n/);
    const variants = [];
    let pendingH = null;
    for (const raw of lines) {
      const l = raw.trim();
      if (!l) continue;
      if (l.startsWith('#EXT-X-STREAM-INF')) {
        const m = l.match(/RESOLUTION=\d+x(\d+)/);
        pendingH = m ? parseInt(m[1]) : null;
      } else if (!l.startsWith('#') && pendingH) {
        variants.push({ height: pendingH, url: l });
        pendingH = null;
      }
    }
    return variants.sort((a, b) => b.height - a.height);
  }
  function pickClosestVariant(variants, targetHeight) {
    if (!variants.length) return null;
    return [...variants].sort((a, b) => Math.abs(a.height - targetHeight) - Math.abs(b.height - targetHeight))[0];
  }

  function parseChunklistText(text, baseUrl) {
    const lines = text.split(/\r?\n/);
    let initUrl = null;
    const segs = [];
    let mediaSeq = 0;
    for (const raw of lines) {
      const l = raw.trim();
      if (!l) continue;
      if (l.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
        mediaSeq = parseInt(l.split(':')[1]);
      } else if (l.startsWith('#EXT-X-MAP')) {
        const m = l.match(/URI="([^"]+)"/);
        if (m) initUrl = new URL(m[1], baseUrl).toString();
      } else if (!l.startsWith('#')) {
        const fn = l.split('?')[0].split('/').pop().replace(/\.m4v$/i, '');
        const parts = fn.split('_');
        const seq = parts.length >= 6 ? (parseInt(parts[5]) || mediaSeq) : mediaSeq;
        segs.push({ seq, url: new URL(l, baseUrl).toString() });
        mediaSeq++;
      }
    }
    return { initUrl, segs };
  }

  async function openSecondaryPanel(cid) {
    const existId = 'cc-cp2-overlay-' + cid;
    if (document.getElementById(existId)) return;
    let info;
    try { info = await fetchLiveMasterUrl(cid); }
    catch (e) { alert('스트림 정보 가져오기 실패: ' + e.message); return; }

    const overlay = document.createElement('div');
    overlay.id = existId;
    overlay.style.cssText = 'position:fixed;right:20px;bottom:20px;width:480px;background:#000;border:2px solid #1AE192;border-radius:8px;z-index:999998;box-shadow:0 8px 30px rgba(0,0,0,0.8);';
    overlay.innerHTML = `
      <div class="cc-cp2-head" style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:#1a1a1a;cursor:move;">
        <span style="color:#1AE192;font-weight:700;font-size:11px;">📺 ${info.channelName || cid.slice(0,8)}</span>
        <button class="cc-cp2-close" style="background:#e04545;color:#fff;border:none;border-radius:3px;padding:3px 8px;cursor:pointer;font-size:10px;">✕</button>
      </div>
      <video class="cc-cp2-video" autoplay muted playsinline style="width:100%;height:270px;display:block;background:#222;object-fit:contain;cursor:pointer;"></video>
      <div style="padding:5px 10px;background:#1a1a1a;display:flex;align-items:center;gap:6px;">
        <button class="cc-cp2-play" style="background:#1AE192;color:#111;border:none;border-radius:3px;padding:3px 8px;cursor:pointer;font-weight:700;width:32px;font-size:11px;">▶</button>
        <button class="cc-cp2-mute" style="background:transparent;border:1px solid #555;color:#ccc;border-radius:3px;padding:3px 6px;cursor:pointer;font-size:11px;width:30px;">🔇</button>
        <input class="cc-cp2-vol" type="range" min="0" max="100" value="80" style="flex:1;height:4px;cursor:pointer;">
        <select class="cc-cp2-quality" style="background:#2a2a32;border:1px solid #555;color:#ccc;border-radius:3px;padding:2px 4px;font-size:10px;cursor:pointer;"></select>
        <button class="cc-cp2-chat-toggle" title="채팅 토글" style="background:transparent;border:1px solid #555;color:#ccc;border-radius:3px;padding:3px 6px;cursor:pointer;font-size:11px;">💬</button>
      </div>
      <div class="cc-cp2-chat-wrap" style="display:none;border-top:1px solid #333;background:#0f0f12;">
        <iframe class="cc-cp2-chat-frame" style="width:100%;height:300px;border:none;background:#0f0f12;display:block;"></iframe>
      </div>
      <div style="padding:4px 10px;background:#1a1a1a;color:#888;font-size:10px;display:flex;justify-content:space-between;">
        <span class="cc-cp2-title" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">${(info.title || '').slice(0, 60)}</span>
        <span class="cc-cp2-status" style="color:#1AE192;flex-shrink:0;margin-left:8px;">로딩...</span>
      </div>
    `;
    document.body.appendChild(overlay);
    enableOverlayDrag(overlay, overlay.querySelector('.cc-cp2-head'));
    const videoEl = overlay.querySelector('.cc-cp2-video');
    const statusEl = overlay.querySelector('.cc-cp2-status');
    let stopped = false;
    overlay.querySelector('.cc-cp2-close').addEventListener('click', () => { stopped = true; overlay.dispatchEvent(new CustomEvent('cc-cp2-cleanup')); overlay.remove(); });
    const playBtn = overlay.querySelector('.cc-cp2-play');
    const muteBtn = overlay.querySelector('.cc-cp2-mute');
    const volEl = overlay.querySelector('.cc-cp2-vol');
    videoEl.volume = 0.8;
    function syncPlayBtn() { playBtn.textContent = videoEl.paused ? '▶' : '⏸'; }
    function syncMuteBtn() { muteBtn.textContent = videoEl.muted || videoEl.volume === 0 ? '🔇' : '🔊'; }
    syncMuteBtn();
    playBtn.addEventListener('click', () => { videoEl.paused ? videoEl.play() : videoEl.pause(); });
    videoEl.addEventListener('play', syncPlayBtn);
    videoEl.addEventListener('pause', syncPlayBtn);
    videoEl.addEventListener('click', () => { videoEl.paused ? videoEl.play() : videoEl.pause(); });
    muteBtn.addEventListener('click', () => { videoEl.muted = !videoEl.muted; syncMuteBtn(); });
    volEl.addEventListener('input', () => { videoEl.volume = parseInt(volEl.value) / 100; if (videoEl.volume > 0) videoEl.muted = false; syncMuteBtn(); });

    const chatToggle = overlay.querySelector('.cc-cp2-chat-toggle');
    const chatWrap = overlay.querySelector('.cc-cp2-chat-wrap');
    const chatFrame = overlay.querySelector('.cc-cp2-chat-frame');
    const chatUrl = `https://chzzk.naver.com/live/${cid}/chat`;
    chatToggle.addEventListener('click', () => {
      const willOpen = chatWrap.style.display === 'none';
      chatWrap.style.display = willOpen ? 'block' : 'none';
      chatToggle.style.background = willOpen ? '#1AE192' : 'transparent';
      chatToggle.style.color = willOpen ? '#111' : '#ccc';
      if (willOpen && !chatFrame.src) chatFrame.src = chatUrl;
    });

    const qualitySelect = overlay.querySelector('.cc-cp2-quality');
    let currentSession = null; // { stop, iv, ms }
    let variants = [];

    async function cleanupSession() {
      if (!currentSession) return;
      currentSession.stop = true;
      clearInterval(currentSession.iv);
      try { videoEl.pause(); } catch (_) {}
      try { videoEl.removeAttribute('src'); videoEl.load(); } catch (_) {}
      currentSession = null;
    }

    async function refreshMasterUrl(prevHeight) {
      // live-detail 다시 호출 + master 재파싱 → 같은 height variant 반환
      const fresh = await fetchLiveMasterUrl(cid);
      info = fresh;
      const masterText = await bgFetchText(info.masterUrl);
      const newVariants = parseMasterVariants(masterText);
      variants = newVariants;
      // dropdown 재구성 (옵션 유지)
      qualitySelect.innerHTML = newVariants.map((v) => `<option value="${v.height}">${v.height}p</option>`).join('');
      const chosen = newVariants.find((v) => v.height === prevHeight) || pickClosestVariant(newVariants, prevHeight);
      qualitySelect.value = String(chosen.height);
      return chosen;
    }
    async function startVariant(variant, attempt = 0) {
      await cleanupSession();
      if (stopped) return;
      statusEl.textContent = `${variant.height}p 로딩…`;
      const session = { stop: false, iv: null };
      currentSession = session;
      try {
        const chunklistUrl = new URL(variant.url, info.masterUrl).toString();
        let firstText;
        try {
          firstText = await bgFetchText(chunklistUrl);
        } catch (e) {
          console.warn('[cc-cp2] chunklist fetch failed', e.status, e.url);
          // 400 / 403: URL/토큰 문제 가능성 → master 갱신 후 1회 재시도
          if (attempt === 0 && (e.status === 400 || e.status === 403)) {
            statusEl.textContent = `토큰 갱신 중…`;
            try {
              const refreshed = await refreshMasterUrl(variant.height);
              return startVariant(refreshed, 1);
            } catch (e2) {
              console.error('[cc-cp2] master 갱신 실패', e2);
              throw new Error(`${e.message} (master 갱신도 실패: ${e2.message})`);
            }
          }
          throw e;
        }
        if (session.stop || stopped) return;
        const { initUrl, segs } = parseChunklistText(firstText, chunklistUrl);
        if (!initUrl || !segs.length) throw new Error('chunklist 빈 응답');

        // segment URL에서 __bgda__ 토큰 추출
        let panelBgda = null;
        try { panelBgda = new URL(segs[0].url).searchParams.get('__bgda__'); } catch (_) {}
        // segment에 없으면 master URL의 hdnts를 그대로 __bgda__로 사용 (chzzk player 패턴)
        if (!panelBgda) {
          try { panelBgda = new URL(info.masterUrl).searchParams.get('hdnts'); } catch (_) {}
        }
        console.log('[cc-cp2] panelBgda:', panelBgda ? 'OK' : 'MISSING', 'sample seg URL:', segs[0]?.url?.slice(0, 200));
        const withPanelBgda = (u) => {
          if (!panelBgda) return u;
          if (/[?&]__bgda__=/.test(u)) return u;
          // searchParams.set은 토큰 내 '=', '~', '*', '/'를 인코딩해 HMAC 검증 실패시킴
          // → 인코딩 없이 raw 문자열로 직접 append
          return u + (u.includes('?') ? '&' : '?') + '__bgda__=' + panelBgda;
        };

        const codecMap = { 1080: 'avc1.64002A', 720: 'avc1.640028', 480: 'avc1.640020', 360: 'avc1.42E01E', 144: 'avc1.42C00C' };
        const vcodec = codecMap[variant.height] || 'avc1.64002A';
        const mimeType = `video/mp4; codecs="${vcodec},mp4a.40.2"`;
        if (!MediaSource.isTypeSupported(mimeType)) throw new Error('codec 지원 안함');

        const ms = new MediaSource();
        videoEl.src = URL.createObjectURL(ms);
        await new Promise((res) => ms.addEventListener('sourceopen', res, { once: true }));
        if (session.stop || stopped) return;
        const sb = ms.addSourceBuffer(mimeType);

        const initBuf = await bgFetchBin(withPanelBgda(initUrl));
        if (session.stop || stopped) return;
        await appendBufAsync(sb, initBuf);

        const appended = new Set();
        for (const s of segs.slice(-5)) {
          try {
            const buf = await bgFetchBin(withPanelBgda(s.url));
            if (session.stop || stopped) return;
            await appendBufAsync(sb, buf);
            appended.add(s.seq);
          } catch (e) { console.warn('[cc-cp2] seg fail', e); }
        }
        if (videoEl.buffered.length) videoEl.currentTime = videoEl.buffered.start(0);
        videoEl.play().catch(() => {});
        statusEl.textContent = `${variant.height}p · live`;

        let lastSegsMap = new Map(segs.map((s) => [s.seq, s.url]));
        let busy = false;
        let consecutive403 = 0;
        session.iv = setInterval(async () => {
          if (session.stop || stopped || busy) return;
          busy = true;
          try {
            let t;
            try {
              t = await bgFetchText(chunklistUrl);
              consecutive403 = 0;
            } catch (e) {
              if (e.status === 400 || e.status === 403) {
                consecutive403++;
                if (consecutive403 >= 2) {
                  console.warn('[cc-cp2] 폴링', e.status, '누적 → master 갱신 후 재시작', e.url);
                  clearInterval(session.iv);
                  session.stop = true;
                  try {
                    const refreshed = await refreshMasterUrl(variant.height);
                    startVariant(refreshed, 0);
                  } catch (e2) { console.error('[cc-cp2] master 갱신 실패', e2); }
                  return;
                }
              }
              throw e;
            }
            if (session.stop || stopped) return;
            const { segs: newSegs } = parseChunklistText(t, chunklistUrl);
            for (const s of newSegs) lastSegsMap.set(s.seq, s.url);
            const buffered = videoEl.buffered;
            const ahead = buffered.length ? buffered.end(buffered.length - 1) - videoEl.currentTime : 0;
            if (ahead < 20) {
              const pending = [...lastSegsMap.entries()].filter(([sq]) => !appended.has(sq)).sort(([a],[b]) => a - b);
              const next = pending[0];
              if (next && !sb.updating) {
                try {
                  const buf = await bgFetchBin(withPanelBgda(next[1]));
                  if (!session.stop && !stopped && !sb.updating) {
                    await appendBufAsync(sb, buf);
                    appended.add(next[0]);
                  }
                } catch (_) {}
              }
            }
            if (sb && !sb.updating && buffered.length) {
              const start = buffered.start(0);
              const cutoff = videoEl.currentTime - 300;
              if (cutoff > start + 10) { try { sb.remove(start, cutoff); } catch (_) {} }
            }
          } catch (e) { console.warn('[cc-cp2] poll fail', e); }
          finally { busy = false; }
        }, 2000);
      } catch (e) {
        statusEl.textContent = '❌ ' + e.message;
        console.error('[cc-cp2]', e);
      }
    }

    try {
      const masterText = await bgFetchText(info.masterUrl);
      if (stopped) return;
      variants = parseMasterVariants(masterText);
      if (!variants.length) throw new Error('variant 없음');
      // dropdown 채우기
      qualitySelect.innerHTML = variants.map((v) => `<option value="${v.height}">${v.height}p</option>`).join('');
      const initial = pickClosestVariant(variants, 720);
      qualitySelect.value = String(initial.height);
      qualitySelect.addEventListener('change', () => {
        const h = parseInt(qualitySelect.value);
        const v = variants.find((x) => x.height === h);
        if (v) startVariant(v);
      });
      await startVariant(initial);
    } catch (e) {
      statusEl.textContent = '❌ ' + e.message;
      console.error('[cc-cp2]', e);
    }

    overlay.addEventListener('cc-cp2-cleanup', () => { stopped = true; cleanupSession(); });
  }

  // 라이브 중인 팔로잉 채널 선택 picker
  async function openChannelPicker() {
    document.getElementById('cc-cp-picker')?.remove();
    const picker = document.createElement('div');
    picker.id = 'cc-cp-picker';
    picker.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:360px;max-height:70vh;background:#1e1e24;border:2px solid #1AE192;border-radius:8px;z-index:1000000;color:#eee;padding:12px;box-shadow:0 8px 30px rgba(0,0,0,0.8);';
    picker.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <span style="font-weight:700;color:#1AE192;">📺 다른 채널 추가</span>
        <button id="cc-cp-picker-close" style="background:transparent;border:none;color:#aaa;cursor:pointer;font-size:16px;">✕</button>
      </div>
      <div id="cc-cp-picker-list" style="overflow-y:auto;max-height:calc(70vh - 60px);font-size:12px;">로딩 중...</div>
    `;
    document.body.appendChild(picker);
    picker.querySelector('#cc-cp-picker-close').addEventListener('click', () => picker.remove());
    try {
      const r = await fetch('https://api.chzzk.naver.com/service/v1/channels/followings/live?size=200', { credentials: 'include', cache: 'no-store' });
      const j = await r.json();
      const list = j?.content?.followingList || j?.content?.data || [];
      const items = list.map((x) => {
        const ch = x.channel || x.streamer?.channel || x;
        return {
          cid: ch.channelId,
          name: ch.channelName,
          img: ch.channelImageUrl || '',
          live: !!(x.streamer?.openLive || x.openLive || ch.openLive),
        };
      }).filter((it) => it.cid);
      // 라이브 먼저, 그 안에서 이름순
      items.sort((a, b) => (b.live - a.live) || a.name.localeCompare(b.name, 'ko'));
      const listEl = picker.querySelector('#cc-cp-picker-list');
      if (!items.length) { listEl.textContent = '팔로잉 채널 없음'; return; }
      listEl.innerHTML = items.map((it) => `
        <div data-cid="${it.cid}" data-live="${it.live}" class="cc-cp-pick-row" style="display:flex;align-items:center;gap:8px;padding:6px;cursor:${it.live ? 'pointer' : 'not-allowed'};border-radius:4px;opacity:${it.live ? '1' : '0.45'};">
          ${it.img ? `<img src="${it.img}" style="width:24px;height:24px;border-radius:50%;">` : ''}
          <span style="flex:1;">${it.name}</span>
          ${it.live
            ? `<span style="display:inline-flex;align-items:center;gap:3px;background:#e04545;color:#fff;font-size:9px;font-weight:700;padding:2px 5px;border-radius:3px;">● LIVE</span>`
            : `<span style="color:#666;font-size:10px;">오프라인</span>`}
        </div>`).join('');
      listEl.querySelectorAll('.cc-cp-pick-row').forEach((row) => {
        if (row.dataset.live !== 'true') return; // 오프라인은 클릭 불가
        row.addEventListener('mouseenter', () => row.style.background = '#2a2a32');
        row.addEventListener('mouseleave', () => row.style.background = '');
        row.addEventListener('click', () => {
          picker.remove();
          openSecondaryPanel(row.dataset.cid);
        });
      });
    } catch (e) {
      picker.querySelector('#cc-cp-picker-list').textContent = '❌ ' + e.message;
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
