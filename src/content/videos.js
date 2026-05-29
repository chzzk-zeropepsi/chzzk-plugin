// CHZZK Companion - VOD(다시보기) 다운로드
(async function () {
  const featCheck = await chrome.storage.local.get('cc_feat_downloads');
  if (featCheck.cc_feat_downloads === false) return;
  const VIDEO_RE = /\/video\/([0-9]+)/;
  const CHANNEL_VIDEOS_RE = /^\/([a-f0-9]{32})\/videos/;
  const videoCache = new Map(); // videoNo -> { videoId, inKey, title, channelName, duration, thumbnailImageUrl }
  let capturedRewindMaster = null; // URL of vod_playlist.m3u8 captured from current /video page

  try {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('inject_rewind.js');
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  } catch (_) {}

  function videoNo() {
    const m = location.pathname.match(VIDEO_RE);
    return m ? m[1] : null;
  }
  function channelVideosId() {
    const m = location.pathname.match(CHANNEL_VIDEOS_RE);
    return m ? m[1] : null;
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (e.data?.source === 'cc-video-list') {
      for (const v of (e.data.data || [])) {
        if (!v.videoNo) continue;
        const prev = videoCache.get(String(v.videoNo)) || {};
        videoCache.set(String(v.videoNo), { ...prev, ...v });
      }
      if (channelVideosId()) injectListOverlays();
    } else if (e.data?.source === 'cc-video-detail') {
      const d = e.data.data || {};
      if (!d.videoNo) return;
      const prev = videoCache.get(String(d.videoNo)) || {};
      videoCache.set(String(d.videoNo), { ...prev, ...d });
    } else if (e.data?.source === 'cc-rewind-manifest') {
      capturedRewindMaster = e.data.url;
    }
  });

  async function fetchVideoDetail(no) {
    const dt = Math.random().toString(16).slice(2, 7);
    const res = await fetch(`https://api.chzzk.naver.com/service/v3/videos/${encodeURIComponent(no)}?dt=${dt}`, { credentials: 'include', cache: 'no-store' });
    if (!res.ok) throw new Error('video detail ' + res.status);
    const j = await res.json();
    const c = j?.content || {};
    return {
      videoNo: c.videoNo,
      videoId: c.videoId,
      inKey: c.inKey,
      title: c.videoTitle,
      duration: c.duration,
      thumbnailImageUrl: c.thumbnailImageUrl,
      channelName: c.channel?.channelName,
    };
  }

  async function fetchPlaybackMpd(videoId, inKey) {
    const url = `https://apis.naver.com/neonplayer/vodplay/v3/playback/${encodeURIComponent(videoId)}?key=${encodeURIComponent(inKey)}&sid=2099&devt=html5_pc&st=13&lc=ko_KR&cpl=ko_KR`;
    const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
    if (!res.ok) throw new Error('playback ' + res.status);
    return res.json();
  }

  function parseRepresentations(mpdJson) {
    const reps = [];
    const adapts = mpdJson?.MPD?.[0]?.Period?.[0]?.AdaptationSet || [];
    for (const a of adapts) {
      for (const r of (a.Representation || [])) {
        const base = r.BaseURL?.[0] || '';
        const tmpl = r.SegmentTemplate?.[0];
        if (!base || !tmpl) continue;
        const tl = tmpl.SegmentTimeline?.[0]?.S || [];
        let segCount = 0;
        for (const s of tl) segCount += 1 + (parseInt(s['@r']) || 0);
        reps.push({
          id: r['@id'],
          height: parseInt(r['@height']) || 0,
          width: parseInt(r['@width']) || 0,
          bandwidth: parseInt(r['@bandwidth']) || 0,
          fps: parseInt(r['@frameRate']) || 0,
          baseUrl: base,
          mediaTemplate: tmpl['@media'],
          startNumber: parseInt(tmpl['@startNumber']) || 0,
          segCount,
          mimeType: a['@mimeType'] || '',
        });
      }
    }
    return reps.filter((r) => r.mimeType === 'video/mp2t' || /\.ts/.test(r.mediaTemplate));
  }

  function estimateBytes(rep, durationSec) {
    return Math.round((rep.bandwidth / 8) * durationSec);
  }
  function fmtBytes(n) {
    if (n > 1e9) return (n / 1e9).toFixed(2) + ' GB';
    if (n > 1e6) return (n / 1e6).toFixed(1) + ' MB';
    if (n > 1e3) return (n / 1e3).toFixed(0) + ' KB';
    return n + ' B';
  }
  function sanitize(s) {
    return String(s || '').replace(/[\\/:*?"<>|\n\r\t]+/g, '_').slice(0, 120).trim() || 'video';
  }

  function buildSegUrl(rep, n) {
    const num = String(n).padStart(6, '0');
    const media = rep.mediaTemplate
      .replace(/\$RepresentationID\$/g, rep.id)
      .replace(/\$Number%06d\$/g, num)
      .replace(/\$Number\$/g, String(n));
    return rep.baseUrl + media;
  }

  let modalEl = null;
  function showQualityModal(meta, mpdJson) {
    closeModal();
    const reps = parseRepresentations(mpdJson).sort((a, b) => b.height - a.height);
    if (!reps.length) { alert('다운로드 가능한 화질을 찾지 못했습니다'); return; }
    const dur = meta.duration || 0;
    modalEl = document.createElement('div');
    modalEl.id = 'cc-vod-modal';
    modalEl.innerHTML = `
      <div class="cc-vod-backdrop"></div>
      <div class="cc-vod-box">
        <div class="cc-vod-head">
          <span>${escapeHtml(meta.title || meta.videoNo)}</span>
          <button class="cc-vod-close" type="button">✕</button>
        </div>
        <div class="cc-vod-info">길이 ${fmtDur(dur)} · 세그먼트 ${reps[0].segCount}개</div>
        <div class="cc-vod-list">
          ${reps.map((r, i) => `
            <button class="cc-vod-q" data-i="${i}">
              <div class="cc-vod-q-main">${r.height}p ${r.fps}fps</div>
              <div class="cc-vod-q-sub">예상 ${fmtBytes(estimateBytes(r, dur))} · ${(r.bandwidth/1e6).toFixed(1)} Mbps</div>
            </button>
          `).join('')}
        </div>
        <div class="cc-vod-warn">.ts 형식으로 저장됩니다 (VLC 등에서 재생 가능). 큰 파일은 메모리 사용량이 큽니다.</div>
        <div class="cc-vod-progress" hidden>
          <div class="cc-vod-bar"><div class="cc-vod-fill"></div></div>
          <div class="cc-vod-status">준비 중…</div>
        </div>
      </div>
    `;
    document.body.appendChild(modalEl);
    modalEl.querySelector('.cc-vod-close').addEventListener('click', closeModal);
    modalEl.querySelector('.cc-vod-backdrop').addEventListener('click', closeModal);
    modalEl.querySelectorAll('.cc-vod-q').forEach((b) => {
      b.addEventListener('click', () => startDownload(meta, reps[parseInt(b.dataset.i)]));
    });
  }
  function closeModal() {
    modalEl?.remove();
    modalEl = null;
  }
  function fmtDur(s) {
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), ss = s%60;
    const pad = (n) => String(n).padStart(2,'0');
    return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
  }
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  let aborted = false;
  async function startDownload(meta, rep) {
    aborted = false;
    const progressEl = modalEl?.querySelector('.cc-vod-progress');
    const fillEl = modalEl?.querySelector('.cc-vod-fill');
    const statusEl = modalEl?.querySelector('.cc-vod-status');
    const list = modalEl?.querySelector('.cc-vod-list');
    if (progressEl) progressEl.hidden = false;
    if (list) list.style.display = 'none';
    const setProg = (done, total, label) => {
      if (fillEl) fillEl.style.width = ((done/total)*100).toFixed(1) + '%';
      if (statusEl) statusEl.textContent = label || `${done}/${total}`;
    };

    const total = rep.segCount;
    const chunks = new Array(total);
    let done = 0;
    const concurrency = 8;
    let next = rep.startNumber;
    const limit = rep.startNumber + total;

    async function worker() {
      while (!aborted) {
        const n = next++;
        if (n >= limit) return;
        const url = buildSegUrl(rep, n);
        try {
          const r = await fetch(url, { credentials: 'omit', cache: 'no-store' });
          if (!r.ok) throw new Error(`segment ${n} ${r.status}`);
          const buf = await r.arrayBuffer();
          chunks[n - rep.startNumber] = buf;
          done++;
          if (done % 5 === 0 || done === total) setProg(done, total);
        } catch (e) {
          aborted = true;
          if (statusEl) statusEl.textContent = '실패: ' + e.message;
          throw e;
        }
      }
    }

    try {
      setProg(0, total, '다운로드 중…');
      await Promise.all(Array.from({length: concurrency}, () => worker()));
      if (aborted) return;
      setProg(total, total, '합치는 중…');
      const blob = new Blob(chunks, { type: 'video/mp2t' });
      const url = URL.createObjectURL(blob);
      const filename = `${sanitize(meta.channelName || '')}_${sanitize(meta.title || meta.videoNo)}_${rep.height}p.ts`;
      await chrome.runtime.sendMessage({ type: 'cc-download', url, filename });
      setProg(total, total, '✓ 저장됨');
      setTimeout(() => { URL.revokeObjectURL(url); closeModal(); }, 2000);
    } catch (_) {}
  }

  function parseMasterM3u8(text, baseUrl) {
    const lines = text.split(/\r?\n/);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l.startsWith('#EXT-X-STREAM-INF')) continue;
      const attrs = {};
      l.replace(/([A-Z0-9-]+)=("([^"]*)"|([^,]*))/g, (_, k, _v, q, b) => { attrs[k] = q ?? b; });
      const uri = (lines[i + 1] || '').trim();
      if (!uri || uri.startsWith('#')) continue;
      const res = (attrs.RESOLUTION || '').split('x');
      out.push({
        bandwidth: parseInt(attrs.BANDWIDTH) || 0,
        width: parseInt(res[0]) || 0,
        height: parseInt(res[1]) || 0,
        url: new URL(uri, baseUrl).toString(),
      });
    }
    return out;
  }
  function parseMediaM3u8(text, baseUrl) {
    const lines = text.split(/\r?\n/);
    let initUrl = null;
    const segs = [];
    let totalDur = 0;
    let pendingDur = 0;
    for (const raw of lines) {
      const l = raw.trim();
      if (!l) continue;
      if (l.startsWith('#EXT-X-MAP')) {
        const m = l.match(/URI="([^"]+)"/);
        if (m) initUrl = new URL(m[1], baseUrl).toString();
      } else if (l.startsWith('#EXTINF')) {
        pendingDur = parseFloat(l.split(':')[1]) || 0;
      } else if (!l.startsWith('#')) {
        segs.push({ url: new URL(l, baseUrl).toString(), dur: pendingDur });
        totalDur += pendingDur;
        pendingDur = 0;
      }
    }
    return { initUrl, segs, totalDur };
  }

  async function downloadRewind(meta, pick) {
    const progressEl = modalEl?.querySelector('.cc-vod-progress');
    const fillEl = modalEl?.querySelector('.cc-vod-fill');
    const statusEl = modalEl?.querySelector('.cc-vod-status');
    const list = modalEl?.querySelector('.cc-vod-list');
    if (progressEl) progressEl.hidden = false;
    if (list) list.style.display = 'none';
    const setProg = (done, total, label) => {
      if (fillEl) fillEl.style.width = ((done/total)*100).toFixed(1) + '%';
      if (statusEl) statusEl.textContent = label || `${done}/${total}`;
    };

    try {
      setProg(0, 1, `${pick.height}p 청크리스트 로딩…`);
      const chunklistRes = await fetch(pick.url, { credentials: 'omit', cache: 'no-store' });
      if (!chunklistRes.ok) throw new Error('chunklist ' + chunklistRes.status);
      const { initUrl, segs, totalDur } = parseMediaM3u8(await chunklistRes.text(), pick.url);
      if (!segs.length) throw new Error('청크 없음');

      const total = segs.length + (initUrl ? 1 : 0);
      const buffers = new Array(total);
      let done = 0;

      if (initUrl) {
        const r = await fetch(initUrl, { credentials: 'omit', cache: 'no-store' });
        if (!r.ok) throw new Error('init ' + r.status);
        buffers[0] = await r.arrayBuffer();
        done++;
        setProg(done, total, `다운로드 중 (${pick.height}p, ${fmtDur(totalDur)})…`);
      }

      const concurrency = 8;
      let next = 0;
      async function worker() {
        while (true) {
          const i = next++;
          if (i >= segs.length) return;
          const r = await fetch(segs[i].url, { credentials: 'omit', cache: 'no-store' });
          if (!r.ok) throw new Error(`segment ${i} ${r.status}`);
          buffers[(initUrl ? 1 : 0) + i] = await r.arrayBuffer();
          done++;
          if (done % 10 === 0 || done === total) setProg(done, total, `다운로드 중 (${pick.height}p, ${fmtDur(totalDur)})…`);
        }
      }
      await Promise.all(Array.from({ length: concurrency }, () => worker()));

      setProg(total, total, '파일 생성 중…');
      const blob = new Blob(buffers, { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);
      const filename = `${sanitize(meta.channelName || '')}_${sanitize(meta.title || meta.videoNo)}_${pick.height}p_rewind.m4s`;
      await chrome.runtime.sendMessage({ type: 'cc-download', url, filename });
      setProg(total, total, '✓ 저장됨');
      setTimeout(() => { URL.revokeObjectURL(url); closeModal(); }, 2000);
    } catch (e) {
      if (statusEl) statusEl.textContent = '실패: ' + e.message;
    }
  }

  function showRewindModal(meta, masterUrl) {
    closeModal();
    modalEl = document.createElement('div');
    modalEl.id = 'cc-vod-modal';
    modalEl.innerHTML = `
      <div class="cc-vod-backdrop"></div>
      <div class="cc-vod-box">
        <div class="cc-vod-head">
          <span>${escapeHtml(meta.title || meta.videoNo)} <em style="color:#e0a93b;font-style:normal;">(실험적: 라이브 다시보기 직접)</em></span>
          <button class="cc-vod-close" type="button">✕</button>
        </div>
        <div class="cc-vod-info">트랜스코딩 전 영상입니다. 화질을 선택하세요.</div>
        <div class="cc-vod-warn">HDN 토큰이 만료되면(약 1시간) 중간에 실패할 수 있습니다. 그땐 페이지 재생을 다시 눌러서 manifest 재캡처 후 시도하세요.</div>
        <div class="cc-vod-progress" hidden>
          <div class="cc-vod-bar"><div class="cc-vod-fill"></div></div>
          <div class="cc-vod-status">준비 중…</div>
        </div>
        <div class="cc-vod-list">화질 정보 로딩 중…</div>
      </div>
    `;
    document.body.appendChild(modalEl);
    modalEl.querySelector('.cc-vod-close').addEventListener('click', closeModal);
    modalEl.querySelector('.cc-vod-backdrop').addEventListener('click', closeModal);

    (async () => {
      try {
        const r = await fetch(masterUrl, { credentials: 'omit', cache: 'no-store' });
        if (!r.ok) throw new Error('master ' + r.status);
        const variants = parseMasterM3u8(await r.text(), masterUrl).sort((a, b) => b.height - a.height);
        if (!variants.length) throw new Error('변종 없음');
        const list = modalEl.querySelector('.cc-vod-list');
        list.innerHTML = variants.map((v, i) => `
          <button class="cc-vod-q" data-i="${i}">
            <div class="cc-vod-q-main">${v.height}p</div>
            <div class="cc-vod-q-sub">${(v.bandwidth / 1e6).toFixed(1)} Mbps</div>
          </button>
        `).join('');
        list.querySelectorAll('.cc-vod-q').forEach((b) => {
          b.addEventListener('click', () => downloadRewind(meta, variants[parseInt(b.dataset.i)]));
        });
      } catch (e) {
        modalEl.querySelector('.cc-vod-list').textContent = '실패: ' + e.message;
      }
    })();
  }

  async function openDownloadForVideo(no) {
    let meta = videoCache.get(String(no));
    if (!meta?.videoId || !meta?.inKey) {
      try {
        const fresh = await fetchVideoDetail(no);
        meta = { ...(meta || {}), ...fresh };
        videoCache.set(String(no), meta);
      } catch (e) { alert('비디오 정보 로드 실패: ' + e.message); return; }
    }
    if (!meta.inKey) {
      if (capturedRewindMaster) {
        showRewindModal(meta, capturedRewindMaster);
        return;
      }
      alert('이 다시보기는 아직 다운로드할 수 없습니다.\n(트랜스코딩 처리 중)\n\n트랜스코딩 전이라도 다운로드를 시도하려면:\n해당 다시보기 페이지에서 ▶ 한 번 눌러서 재생을 시작한 뒤 다시 시도하세요.');
      return;
    }
    let mpd;
    try {
      mpd = await fetchPlaybackMpd(meta.videoId, meta.inKey);
    } catch (e) { alert('재생 정보 로드 실패: ' + e.message); return; }
    showQualityModal(meta, mpd);
  }

  // ───── 패널 헤더 버튼 (개별 VOD 페이지) ─────
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
  async function injectPanelButton() {
    const no = videoNo();
    if (!no) return;
    await waitForPanel();
    const header = document.querySelector('#cc-followings-panel .cc-fp-header');
    if (!header) return;
    if (header.querySelector('#cc-vod-dl-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'cc-vod-dl-btn';
    btn.type = 'button';
    btn.title = '다시보기 다운로드';
    btn.textContent = '🎞️ 다운로드';
    const refreshBtn = header.querySelector('.cc-fp-refresh');
    const parent = refreshBtn?.parentElement || header;
    parent.insertBefore(btn, refreshBtn);
    btn.addEventListener('click', () => openDownloadForVideo(videoNo() || no));
  }

  // ───── 채널 비디오 목록 오버레이 ─────
  function injectListOverlays(scope) {
    const links = (scope || document).querySelectorAll('a[class*="video_card_thumbnail"][href*="/video/"]');
    for (const a of links) {
      const m = a.getAttribute('href')?.match(VIDEO_RE);
      if (!m) continue;
      if (a.querySelector('.cc-vod-dl-overlay')) continue;
      const cs = getComputedStyle(a);
      if (cs.position === 'static') a.style.position = 'relative';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cc-vod-dl-overlay';
      btn.title = '다시보기 다운로드';
      btn.textContent = '⬇';
      btn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        openDownloadForVideo(m[1]);
      });
      a.appendChild(btn);
    }
  }
  let listObserver = null;
  function startListMode() {
    injectListOverlays();
    listObserver?.disconnect();
    listObserver = new MutationObserver(() => injectListOverlays());
    listObserver.observe(document.body, { childList: true, subtree: true });
  }
  function stopListMode() {
    listObserver?.disconnect();
    listObserver = null;
    document.querySelectorAll('.cc-vod-dl-overlay').forEach((b) => b.remove());
  }

  function cleanup() {
    document.getElementById('cc-vod-dl-btn')?.remove();
    closeModal();
  }
  function refresh() {
    cleanup();
    stopListMode();
    if (channelVideosId()) startListMode();
  }

  refresh();
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    refresh();
  }, 1500);
})();
