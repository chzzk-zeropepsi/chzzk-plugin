// CHZZK Companion - VOD(다시보기) 다운로드
(async function () {
  const featCheck = await chrome.storage.local.get('cc_feat_downloads');
  if (featCheck.cc_feat_downloads === false) return;
  const VIDEO_RE = /\/video\/([0-9]+)/;
  const CHANNEL_VIDEOS_RE = /^\/([a-f0-9]{32})\/videos/;
  const videoCache = new Map(); // videoNo -> { videoId, inKey, title, channelName, duration, thumbnailImageUrl }

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
      alert('이 다시보기는 아직 다운로드할 수 없습니다.\n(트랜스코딩 처리 중일 수 있습니다 — 라이브 종료 후 보통 수십분~수시간 후 가능)');
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
    const links = (scope || document).querySelectorAll('a[href*="/video/"]');
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
