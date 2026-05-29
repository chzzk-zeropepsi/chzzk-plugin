// CHZZK Companion - 라이브 녹화 (player의 hook 기반 + 풀 segment 보강)
(async function () {
  const featCheck = await chrome.storage.local.get('cc_feat_downloads');
  if (featCheck.cc_feat_downloads === false) return;

  const LIVE_RE = /^\/live\/([^/?#]+)/;
  const ACTIVE_KEY = 'cc_active_recordings';
  const myRecId = Math.random().toString(36).slice(2);
  let masterUrl = null;
  let recState = null;
  let bgdaToken = null;
  let chunklistUrl = null;
  // 항상 누적: 화질별 segment URL (look-back용, URL만 저장 — 메모리 부담 작음)
  const accumSegsByHeight = new Map(); // height -> Map<seq, segUrl>
  const accumInitByHeight = new Map(); // height -> initUrl
  const ACCUM_CAP = 10800; // 화질별 약 6시간 분량 (~2초/segment), chunklist가 주는 만큼 다 들고감
  const ACCUM_TTL_MS = 12 * 3600 * 1000; // segment URL 신선도: 12시간 지나면 CDN evict 가능성 높음
  const ACCUM_STORAGE_PREFIX = 'cc_accum_';

  function pruneStaleSegs() {
    const now = Date.now();
    for (const [h, segMap] of accumSegsByHeight) {
      for (const [seq, url] of segMap) {
        const fn = url.split('?')[0].split('/').pop();
        const ts = tsFromFilename(fn);
        if (ts && (now - ts) > ACCUM_TTL_MS) segMap.delete(seq);
      }
      if (segMap.size === 0) accumSegsByHeight.delete(h);
    }
  }

  async function saveAccumToStorage(cid) {
    if (!cid) return;
    try {
      const segs = {};
      for (const [h, m] of accumSegsByHeight) segs[h] = Object.fromEntries(m);
      const init = Object.fromEntries(accumInitByHeight);
      await chrome.storage.local.set({
        [ACCUM_STORAGE_PREFIX + cid]: { segs, init, savedAt: Date.now() },
      });
    } catch (e) {
      if (String(e.message).includes('Extension context')) ctxInvalid = true;
    }
  }

  async function loadAccumFromStorage(cid) {
    if (!cid) return;
    try {
      const key = ACCUM_STORAGE_PREFIX + cid;
      const o = await chrome.storage.local.get(key);
      const data = o[key];
      if (!data) return;
      for (const [hStr, segs] of Object.entries(data.segs || {})) {
        const h = parseInt(hStr);
        let m = accumSegsByHeight.get(h);
        if (!m) { m = new Map(); accumSegsByHeight.set(h, m); }
        // 기존(신선) > 저장(오래됨): 이미 있는 seq는 덮어쓰지 않음
        for (const [seq, url] of Object.entries(segs)) {
          const sq = parseInt(seq);
          if (!m.has(sq)) m.set(sq, url);
        }
      }
      for (const [h, url] of Object.entries(data.init || {})) {
        if (!accumInitByHeight.has(parseInt(h))) accumInitByHeight.set(parseInt(h), url);
      }
      pruneStaleSegs();
      const counts = [...accumSegsByHeight.entries()].map(([h, m]) => `${h}p:${m.size}`).join(', ');
    } catch (e) {
      if (String(e.message).includes('Extension context')) ctxInvalid = true;
    }
  }

  // 24시간 이상 안 본 채널 accum 정리
  async function cleanupOldAccumKeys() {
    try {
      const all = await chrome.storage.local.get(null);
      const cutoff = Date.now() - 24 * 3600 * 1000;
      const toRemove = [];
      for (const [k, v] of Object.entries(all)) {
        if (k.startsWith(ACCUM_STORAGE_PREFIX) && v?.savedAt && v.savedAt < cutoff) toRemove.push(k);
      }
      if (toRemove.length) await chrome.storage.local.remove(toRemove);
    } catch (_) {}
  }
  // 이전 버전이 저장한 storage 키들 정리 (더 이상 사용 안 함)
  (async () => {
    try {
      const all = await chrome.storage.local.get(null);
      const toRemove = Object.keys(all).filter((k) => k.startsWith(ACCUM_STORAGE_PREFIX));
      if (toRemove.length) await chrome.storage.local.remove(toRemove);
    } catch (_) {}
  })();

  let pendingSaveCid = null;
  let saveTimer = null;
  function scheduleSave() {
    const cid = liveCid();
    if (!cid) return;
    pendingSaveCid = cid;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveAccumToStorage(pendingSaveCid);
    }, 5000);
  }

  function parseSegSeqFromName(filename) {
    const base = filename.split('?')[0].replace(/\.m4v$/i, '');
    const parts = base.split('_');
    if (parts.length >= 6) return parseInt(parts[5]);
    return NaN;
  }

  const STALE_MS = 8000; // heartbeat 없으면 dead 탭으로 간주
  async function getActiveRecordings() {
    try {
      const o = await chrome.storage.local.get(ACTIVE_KEY);
      const raw = Array.isArray(o[ACTIVE_KEY]) ? o[ACTIVE_KEY] : [];
      const now = Date.now();
      const alive = raw.filter((x) => x.lastSeen && (now - x.lastSeen) < STALE_MS);
      if (alive.length !== raw.length) {
        await chrome.storage.local.set({ [ACTIVE_KEY]: alive });
      }
      return alive;
    } catch (e) {
      if (String(e.message).includes('Extension context')) ctxInvalid = true;
      return [];
    }
  }
  let ctxInvalid = false;
  async function addActiveRecording(info) {
    const list = await getActiveRecordings();
    list.push({ ...info, lastSeen: Date.now() });
    await chrome.storage.local.set({ [ACTIVE_KEY]: list });
  }
  async function heartbeatActive(id) {
    const o = await chrome.storage.local.get(ACTIVE_KEY);
    const raw = Array.isArray(o[ACTIVE_KEY]) ? o[ACTIVE_KEY] : [];
    let changed = false;
    const updated = raw.map((x) => {
      if (x.id === id) { changed = true; return { ...x, lastSeen: Date.now() }; }
      return x;
    });
    if (changed) await chrome.storage.local.set({ [ACTIVE_KEY]: updated });
  }
  async function removeActiveRecording(id) {
    const o = await chrome.storage.local.get(ACTIVE_KEY);
    const list = Array.isArray(o[ACTIVE_KEY]) ? o[ACTIVE_KEY] : [];
    await chrome.storage.local.set({ [ACTIVE_KEY]: list.filter((x) => x.id !== id) });
  }

  function bgFetchText(url) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'cc-bg-fetch-text', url }, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res || !res.ok) return reject(new Error('http ' + (res?.status || res?.error || '?')));
        resolve(res.text);
      });
    });
  }
  function parseMedia(text, baseUrl) {
    const lines = text.split(/\r?\n/);
    let initUrl = null;
    const segs = [];
    for (const raw of lines) {
      const l = raw.trim();
      if (!l) continue;
      if (l.startsWith('#EXT-X-MAP')) {
        const m = l.match(/URI="([^"]+)"/);
        if (m) initUrl = new URL(m[1], baseUrl).toString();
      } else if (!l.startsWith('#')) {
        segs.push(new URL(l, baseUrl).toString());
      }
    }
    return { initUrl, segs };
  }
  function withBgda(url) {
    if (!bgdaToken) return url;
    try {
      const u = new URL(url);
      if (!u.searchParams.has('__bgda__')) u.searchParams.set('__bgda__', bgdaToken);
      return u.toString();
    } catch (_) { return url; }
  }
  function bgFetchBin(url) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'cc-bg-fetch-bin', url }, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res || !res.ok) return reject(new Error('http ' + (res?.status || res?.error || '?')));
        const bin = atob(res.b64);
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        resolve(buf.buffer);
      });
    });
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d) return;
    if (d.source === 'cc-live-chunklist-url') {
      chunklistUrl = (() => {
        try {
          const u = new URL(d.url);
          ['_HLS_msn', '_HLS_part', '_HLS_skip'].forEach((k) => u.searchParams.delete(k));
          return u.toString();
        } catch (_) { return d.url; }
      })();
    } else if (d.source === 'cc-live-chunklist-text') {
      // 화질별 segment URL 누적 (look-back용) + 원본 보존 (rewind용)
      try {
        const m = d.baseUrl.match(/\/(\d+)p\//);
        if (!m) return;
        const h = parseInt(m[1]);
        lastChunklistTextByHeight.set(h, d.text);
        lastChunklistBaseUrlByHeight.set(h, d.baseUrl);
        let segMap = accumSegsByHeight.get(h);
        if (!segMap) { segMap = new Map(); accumSegsByHeight.set(h, segMap); }
        const lines = d.text.split(/\r?\n/);
        for (const raw of lines) {
          const l = raw.trim();
          if (!l) continue;
          if (l.startsWith('#EXT-X-MAP')) {
            const mm = l.match(/URI="([^"]+)"/);
            if (mm) accumInitByHeight.set(h, new URL(mm[1], d.baseUrl).toString());
          } else if (!l.startsWith('#')) {
            const fn = l.split('?')[0];
            const seq = parseSegSeqFromName(fn);
            if (!Number.isFinite(seq)) continue;
            if (!segMap.has(seq)) {
              segMap.set(seq, new URL(l, d.baseUrl).toString());
            }
          }
        }
        // cap to last ACCUM_CAP entries
        if (segMap.size > ACCUM_CAP) {
          const sorted = [...segMap.keys()].sort((a, b) => a - b);
          for (const k of sorted.slice(0, segMap.size - ACCUM_CAP)) segMap.delete(k);
        }
      } catch (_) {}
    } else if (d.source === 'cc-live-seg-url') {
      try {
        const u = new URL(d.url);
        const t = u.searchParams.get('__bgda__');
        if (t) bgdaToken = t;
      } catch (_) {}
    }
  });

  function liveCid() {
    const m = location.pathname.match(LIVE_RE);
    return m ? m[1] : null;
  }
  function fmtBytes(n) {
    if (n > 1e9) return (n / 1e9).toFixed(2) + ' GB';
    if (n > 1e6) return (n / 1e6).toFixed(1) + ' MB';
    if (n > 1e3) return (n / 1e3).toFixed(0) + ' KB';
    return n + ' B';
  }
  function fmtDur(s) {
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
  }
  function sanitize(s) {
    return String(s || '').replace(/[\\/:*?"<>|\n\r\t]+/g, '_').slice(0, 80).trim() || 'live';
  }
  function getChannelInfo() {
    const ch = document.querySelector('a.video_information_link__2OrbG .name_text__yQG50')
      || document.querySelector('[class*="video_information_name"] [class*="name_text"]')
      || document.querySelector('[class*="channel"] [class*="name_text"]');
    const channelName = (ch?.textContent || '').trim();
    const full = document.title.replace(/ - CHZZK$/, '').trim();
    const fromTitle = full.split(' - ')[0]?.trim() || '';
    return { channelName: channelName || fromTitle || '?', fullTitle: full };
  }

  // fMP4 media segment의 tfdt(baseMediaDecodeTime)를 트랙별 첫 값 기준으로 재계산하여
  // 녹화 파일의 타임라인이 0:00부터 시작하도록 만든다.
  function rebaseSegmentTimeline(segBuf, firstSeenByTrack) {
    // segBuf의 mp4 박스를 워킹하여 moof > traf 내 tfhd로 trackId 파악 후
    // 같은 traf 내 tfdt의 baseMediaDecodeTime을 firstSeenByTrack[trackId] 기준으로 차감
    const src = new Uint8Array(segBuf);
    const u8 = new Uint8Array(src.length);
    u8.set(src);
    const view = new DataView(u8.buffer);
    function readType(off) { return String.fromCharCode(u8[off], u8[off+1], u8[off+2], u8[off+3]); }
    function walkTraf(start, end) {
      let trackId = null;
      let p = start;
      while (p + 8 <= end) {
        const size = view.getUint32(p);
        if (size < 8 || p + size > end) break;
        const type = readType(p + 4);
        const bs = p + 8;
        if (type === 'tfhd') {
          trackId = view.getUint32(bs + 4);
        } else if (type === 'tfdt' && trackId !== null) {
          const version = u8[bs];
          if (version === 1) {
            const high = view.getUint32(bs + 4);
            const low = view.getUint32(bs + 8);
            const t = high * 0x100000000 + low;
            if (!firstSeenByTrack.has(trackId)) firstSeenByTrack.set(trackId, t);
            const newT = Math.max(0, t - firstSeenByTrack.get(trackId));
            view.setUint32(bs + 4, Math.floor(newT / 0x100000000));
            view.setUint32(bs + 8, newT >>> 0);
          } else {
            const t = view.getUint32(bs + 4);
            if (!firstSeenByTrack.has(trackId)) firstSeenByTrack.set(trackId, t);
            const newT = Math.max(0, t - firstSeenByTrack.get(trackId)) >>> 0;
            view.setUint32(bs + 4, newT);
          }
        }
        p += size;
      }
    }
    function walkMoof(start, end) {
      let p = start;
      while (p + 8 <= end) {
        const size = view.getUint32(p);
        if (size < 8 || p + size > end) break;
        const type = readType(p + 4);
        if (type === 'traf') walkTraf(p + 8, p + size);
        p += size;
      }
    }
    let p = 0;
    while (p + 8 <= u8.length) {
      const size = view.getUint32(p);
      if (size < 8 || p + size > u8.length) break;
      const type = readType(p + 4);
      if (type === 'moof') walkMoof(p + 8, p + size);
      p += size;
    }
    return u8.buffer;
  }

  async function startRecording() {
    const { channelName, fullTitle: title } = getChannelInfo();
    // 한 번에 한 라이브만 녹화 가능
    const active = await getActiveRecordings();
    const others = active.filter((x) => x.id !== myRecId);
    if (others.length) {
      alert(`이미 다른 탭에서 녹화 중입니다: ${others.map((x) => x.channelName).join(', ')}`);
      return;
    }
    await addActiveRecording({ id: myRecId, channelName, startedAt: Date.now() });
    let initBuf = null;
    let totalBytes = 0, totalDur = 0, chunkCount = 0;
    let lockedHeight = null;
    const segsBySeq = new Map(); // seq -> ArrayBuffer (full segment)
    const fetching = new Set();
    let stopped = false;
    let lastChunkTs = Date.now();
    const IDLE_TIMEOUT_MS = 30000;

    function beforeUnload(e) {
      try { removeActiveRecording(myRecId); } catch (_) {}
      e.preventDefault();
      e.returnValue = '녹화 중입니다. 페이지를 이동하면 녹화가 종료되고 받은 데이터가 사라집니다.';
      return e.returnValue;
    }
    function pagehide() {
      try { removeActiveRecording(myRecId); } catch (_) {}
    }
    window.addEventListener('pagehide', pagehide);
    window.addEventListener('beforeunload', beforeUnload);

    // chunklist 도착 대기 (최대 5초)
    let chunklistUrl = null;
    for (let i = 0; i < 50 && !chunklistUrl; i++) {
      const heights = [...lastChunklistBaseUrlByHeight.keys()];
      if (heights.length) {
        // 가장 높은 화질 (= player가 현재 사용 중일 가능성 높음)
        lockedHeight = Math.max(...heights);
        chunklistUrl = lastChunklistBaseUrlByHeight.get(lockedHeight);
      } else {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (!chunklistUrl) {
      alert('chunklist를 아직 수집하지 못했습니다. 영상을 잠시 더 본 후 다시 시도해주세요.');
      await removeActiveRecording(myRecId);
      return;
    }

    // init segment 한 번 fetch
    const initUrl = accumInitByHeight.get(lockedHeight);
    if (initUrl) {
      try {
        initBuf = await bgFetchBin(withBgda(initUrl));
        totalBytes += initBuf.byteLength;
        chunkCount++;
      } catch (e) { console.error('[cc-rec] init fetch failed:', e); }
    }

    async function fetchSeg(seq, url) {
      if (fetching.has(seq) || segsBySeq.has(seq) || stopped) return;
      fetching.add(seq);
      try {
        const buf = await bgFetchBin(withBgda(url));
        if (stopped) return;
        segsBySeq.set(seq, buf);
        totalBytes += buf.byteLength;
        totalDur += 2;
        chunkCount++;
        lastChunkTs = Date.now();
      } catch (e) {
        // 실패 시 다음 폴링에서 재시도 가능
      } finally {
        fetching.delete(seq);
      }
    }

    // chunklist 폴링: 2.5초마다 새 segment 발견 → background fetch
    const pollIv = setInterval(async () => {
      if (stopped) return;
      try {
        const text = await bgFetchText(chunklistUrl);
        if (stopped) return;
        const { segs } = parseChunklistText(text, chunklistUrl);
        for (const s of segs) {
          if (!segsBySeq.has(s.seq) && !fetching.has(s.seq)) fetchSeg(s.seq, s.url);
        }
      } catch (e) { /* 일시적 실패 무시 */ }
    }, 2500);

    function updateStatusRow() {
      const row = ensureStatusRow();
      if (!row) return;
      row.querySelector('.cc-rec-channel').textContent = channelName;
      row.querySelector('.cc-rec-time').textContent = fmtDur(totalDur);
      row.querySelector('.cc-rec-size').textContent = fmtBytes(totalBytes);
      row.querySelector('.cc-rec-chunks').textContent = `${chunkCount}개`;
      row.querySelector('.cc-rec-quality').textContent = lockedHeight ? lockedHeight + 'p' : '대기중';
    }
    const tickIv = setInterval(() => {
      updateStatusRow();
      if (chunkCount > 0 && Date.now() - lastChunkTs > IDLE_TIMEOUT_MS) saveAndCleanup();
    }, 1000);

    async function saveAndCleanup() {
      if (stopped) return;
      stopped = true;
      window.removeEventListener('beforeunload', beforeUnload);
      clearInterval(pollIv);
      clearInterval(tickIv);
      // 진행 중인 fetch들 마무리 대기 (최대 5초)
      const waitStart = Date.now();
      while (fetching.size && Date.now() - waitStart < 5000) {
        await new Promise((r) => setTimeout(r, 100));
      }
      removeStatusRow();
      await removeActiveRecording(myRecId);
      const btn = document.getElementById('cc-live-rec-btn');
      if (btn) btn.textContent = '저장 중…';
      try {
        const ordered = [];
        const seqs = [...segsBySeq.keys()].sort((a, b) => a - b);
        // 각 segment의 tfdt를 0 기준으로 재작성 — 녹화 파일 타임라인이 0:00부터 시작하도록
        const firstSeenByTrack = new Map();
        for (const s of seqs) {
          try { ordered.push(rebaseSegmentTimeline(segsBySeq.get(s), firstSeenByTrack)); }
          catch (_) { ordered.push(segsBySeq.get(s)); }
        }
        // init 누락 시 마지막 시도
        if (!initBuf && accumInitByHeight.has(lockedHeight)) {
          try { initBuf = await bgFetchBin(withBgda(accumInitByHeight.get(lockedHeight))); }
          catch (e) { console.error('[cc-rec] init fetch failed:', e); }
        }
        const all = initBuf ? [initBuf, ...ordered] : ordered;
        const validated = all.filter((b) => b && (b instanceof ArrayBuffer || ArrayBuffer.isView(b)));
        if (!validated.length) {
          // 청크 수집 전 중지: silent cleanup
          const btn3 = document.getElementById('cc-live-rec-btn');
          if (btn3) btn3.textContent = '🔴';
          recState = null;
          updateUi();
          return;
        }
        const blob = new Blob(validated, { type: 'video/mp4' });
        const url = URL.createObjectURL(blob);
        const filename = `${sanitize(title)}_${lockedHeight || '?'}p_live_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.mp4`;
        await chrome.runtime.sendMessage({ type: 'cc-download', url, filename });
        if (btn) btn.textContent = `✓ ${fmtBytes(blob.size)}`;
        setTimeout(() => { URL.revokeObjectURL(url); recState = null; updateUi(); }, 3000);
      } catch (e) {
        console.error('[cc-rec] save failed:', e);
        const btn2 = document.getElementById('cc-live-rec-btn');
        if (btn2) btn2.textContent = '저장 실패: ' + e.message;
        recState = null;
        updateUi();
      }
    }

    recState = { stop: saveAndCleanup };
    updateUi();
    updateStatusRow();
    // heartbeat: 5초마다 alive 표시
    const heartbeatIv = setInterval(() => {
      if (stopped) { clearInterval(heartbeatIv); return; }
      heartbeatActive(myRecId).catch(() => {});
    }, 5000);

    // 시나리오 A + B: 현재 chunklist + 누적된 과거 URL을 모두 background로 미리 받기 (look-back)
    (async () => {
      if (!bgdaToken) return;
      try {
        // 1. 현재 chunklist 가져오기 (가능하면)
        let initUrl = null;
        const segs = [];
        if (chunklistUrl) {
          try {
            const text = await bgFetchText(chunklistUrl);
            const parsed = parseMedia(text, chunklistUrl);
            initUrl = parsed.initUrl;
            for (const s of parsed.segs) segs.push(s);
          } catch (_) {}
        }
        // 2. 누적된 과거 URL 추가 (락 화질 또는 모든 화질의 첫 화질)
        const targetH = lockedHeight || [...accumSegsByHeight.keys()][0];
        if (targetH) {
          const accumSegs = accumSegsByHeight.get(targetH);
          if (accumSegs) {
            const sortedSeqs = [...accumSegs.keys()].sort((a, b) => a - b);
            for (const seq of sortedSeqs) segs.push(accumSegs.get(seq));
          }
          if (!initUrl) initUrl = accumInitByHeight.get(targetH) || null;
        }
        // dedup by filename
        const seenFn = new Set();
        const uniqSegs = [];
        for (const u of segs) {
          const fn = u.split('?')[0].split('/').pop();
          if (seenFn.has(fn)) continue;
          seenFn.add(fn);
          uniqSegs.push(u);
        }
        // chunklist의 segments는 full 형태 (filename 7-part가 아닌 6-part). bucket.full로 들어감
        if (initUrl && !initBuf) {
          try {
            const ib = await bgFetchBin(withBgda(initUrl));
            if (!initBuf) {
              initBuf = ib;
              totalBytes += ib.byteLength;
              chunkCount++;
              lastChunkTs = Date.now();
            }
          } catch (_) {}
        }
        let lookbackCount = 0;
        let fail404Count = 0;
        for (const segUrl of uniqSegs) {
          if (stopped) return;
          const fn = segUrl.split('?')[0].split('/').pop();
          const meta = parseSegName(fn);
          if (!meta || !Number.isFinite(meta.seq)) continue;
          const existing = piecesBySeq.get(meta.seq);
          if (existing?.full) continue;
          // 화질 잠금 후에만 다른 화질 거름
          const qm = fn.match(/^(\d+)p_/);
          if (qm && lockedHeight !== null && parseInt(qm[1]) !== lockedHeight) continue;
          if (qm && lockedHeight === null) lockedHeight = parseInt(qm[1]);
          try {
            const buf = await bgFetchBin(withBgda(segUrl));
            const bucket = existing || { full: null, parts: new Map() };
            if (!piecesBySeq.has(meta.seq)) piecesBySeq.set(meta.seq, bucket);
            bucket.full = buf;
            bucket.parts.clear();
            totalBytes += buf.byteLength;
            chunkCount++;
            totalDur += 4;
            lastChunkTs = Date.now();
            lookbackCount++;
            updateStatusRow();
          } catch (e) {
            if (String(e.message).includes('404')) fail404Count++;
          }
        }
      } catch (e) {
        console.warn('[cc-rec] lookback failed:', e);
      }
    })();
  }

  // ───── 라이브 되돌리기 (별도 video element + MSE로 누적 segment 재생) ─────
  const lastChunklistTextByHeight = new Map();
  let lastChunklistBaseUrlByHeight = new Map();

  function buildRewoundChunklistFromAccum_unused(height, seconds) {
    const segMap = accumSegsByHeight.get(height);
    const origText = lastChunklistTextByHeight.get(height);
    if ((!segMap || segMap.size === 0) && !origText) return null;
    const targetTs = Date.now() - seconds * 1000;
    const initUrl = accumInitByHeight.get(height);

    // 원본 chunklist 파싱 — 헤더 + 현재 segment 목록
    let origHeader = [];
    let origMapLine = null;
    let origSeqStart = 0;
    const origEntries = []; // { pdt, extinf, url }
    if (origText) {
      const lines = origText.split(/\r?\n/);
      let i = 0;
      while (i < lines.length) {
        const l = lines[i].trim();
        if (l.startsWith('#EXT-X-MAP') || (!l.startsWith('#') && l)) break;
        if (l.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
          origSeqStart = parseInt(l.split(':')[1]) || 0;
          origHeader.push(l);
        } else if (l.startsWith('#EXT-X-SERVER-CONTROL') || l.startsWith('#EXT-X-PART-INF')) {
          // LL-HLS 관련 헤더는 제거 (blocking reload 단순화)
        } else if (l) {
          origHeader.push(l);
        }
        i++;
      }
      if (i < lines.length && lines[i].trim().startsWith('#EXT-X-MAP')) {
        origMapLine = lines[i].trim();
        i++;
      }
      let pendingPdt = null;
      let pendingExtinf = null;
      while (i < lines.length) {
        const l = lines[i].trim();
        if (l.startsWith('#EXT-X-PROGRAM-DATE-TIME')) pendingPdt = l;
        else if (l.startsWith('#EXTINF')) pendingExtinf = l;
        else if (l.startsWith('#EXT-X-PART') || l.startsWith('#EXT-X-PRELOAD-HINT') || l.startsWith('#EXT-X-RENDITION-REPORT')) {
          // LL-HLS partial 라인 제거
        } else if (l && !l.startsWith('#')) {
          const fullUrl = new URL(l, lastChunklistBaseUrlByHeight.get(height) || '').toString();
          origEntries.push({ pdt: pendingPdt, extinf: pendingExtinf || '#EXTINF:2.000,', url: fullUrl });
          pendingPdt = null;
          pendingExtinf = null;
        }
        i++;
      }
    }

    // 누적 URL 중 targetTs ≤ ts < origSeqStart 범위만 추출
    const pastEntries = [];
    const origSeqMin = origEntries.length ? origSeqStart : Infinity;
    if (segMap) {
      const sortedSeqs = [...segMap.keys()].sort((a, b) => a - b);
      for (const seq of sortedSeqs) {
        if (seq >= origSeqMin) break;
        const url = segMap.get(seq);
        const fn = url.split('?')[0].split('/').pop();
        const ts = tsFromFilename(fn);
        if (!ts || ts < targetTs) continue;
        pastEntries.push({
          pdt: ts ? `#EXT-X-PROGRAM-DATE-TIME:${new Date(ts).toISOString()}` : null,
          extinf: '#EXTINF:2.000,',
          url,
          seq,
        });
      }
    }

    if (pastEntries.length === 0 && !origEntries.length) return null;

    // 새 MEDIA-SEQUENCE: 가장 오래된 past entry의 seq (있으면) 또는 원본 그대로
    const newSeq = pastEntries.length ? pastEntries[0].seq : origSeqStart;

    // 표준 HLS v7으로 다운그레이드 (LL-HLS 관련 필드 다 제거, BigInt 파싱 에러 회피)
    const out = [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-INDEPENDENT-SEGMENTS',
      '#EXT-X-TARGETDURATION:3',
      `#EXT-X-MEDIA-SEQUENCE:${newSeq}`,
      '#EXT-X-DISCONTINUITY-SEQUENCE:0',
    ];
    // 원본의 DATERANGE 유지 (방송 시작 시각 정보 필요)
    const dateRangeMatch = origText && origText.match(/^#EXT-X-DATERANGE:.+$/m);
    if (dateRangeMatch) out.push(dateRangeMatch[0]);
    if (origMapLine) {
      // EXT-X-MAP URI가 상대경로면 절대 URL로 변환
      const mapMatch = origMapLine.match(/URI="([^"]+)"/);
      if (mapMatch) {
        const absInit = new URL(mapMatch[1], lastChunklistBaseUrlByHeight.get(height) || '').toString();
        out.push(`#EXT-X-MAP:URI="${absInit}"`);
      } else {
        out.push(origMapLine);
      }
    } else if (initUrl) {
      out.push(`#EXT-X-MAP:URI="${initUrl}"`);
    }
    for (const e of pastEntries) {
      if (e.pdt) out.push(e.pdt);
      out.push(e.extinf);
      out.push(e.url);
    }
    for (const e of origEntries) {
      if (e.pdt) out.push(e.pdt);
      out.push(e.extinf);
      out.push(e.url);
    }
    return out.join('\n');
  }

  function closeRewindPlayer() {
    const ov = document.getElementById('cc-cp-overlay');
    if (ov) {
      ov.dispatchEvent(new CustomEvent('cc-cp-cleanup'));
      const v = ov.querySelector('video');
      if (v) v.src = '';
      ov.remove();
    }
    const btn = document.getElementById('cc-rewind-btn');
    if (btn) { btn.style.background = ''; btn.style.color = ''; btn.title = '라이브 되돌리기 (별도 플레이어)'; btn.textContent = '⏪'; }
  }

  // ───── 별도 video element + MSE로 누적 segment 재생 ─────
  const CODEC_BY_HEIGHT = {
    1080: 'avc1.64002A,mp4a.40.2',
    720: 'avc1.640028,mp4a.40.2',
    480: 'avc1.4D001F,mp4a.40.2',
    360: 'avc1.4D001E,mp4a.40.2',
    144: 'avc1.4D000C,mp4a.40.2',
  };

  function appendBufAsync(sb, buf) {
    return new Promise((resolve, reject) => {
      const onU = () => { sb.removeEventListener('updateend', onU); sb.removeEventListener('error', onE); resolve(); };
      const onE = () => { sb.removeEventListener('updateend', onU); sb.removeEventListener('error', onE); reject(new Error('sourceBuffer error')); };
      sb.addEventListener('updateend', onU);
      sb.addEventListener('error', onE);
      try { sb.appendBuffer(buf); } catch (e) { sb.removeEventListener('updateend', onU); sb.removeEventListener('error', onE); reject(e); }
    });
  }

  async function showRewindPlayer() {
    document.getElementById('cc-cp-overlay')?.remove();
    if (accumSegsByHeight.size === 0) {
      alert('아직 누적된 영상이 없습니다.\n영상을 잠시 재생한 후 다시 시도해주세요.');
      return;
    }
    const heights = [...accumSegsByHeight.keys()].sort((a, b) => b - a);
    const height = heights[0];
    const segMap = accumSegsByHeight.get(height);
    const initUrl = accumInitByHeight.get(height);
    if (!initUrl) { alert('init segment URL이 캡처되지 않았습니다. 영상을 잠시 더 보세요.'); return; }
    const codecs = CODEC_BY_HEIGHT[height] || 'avc1.640028,mp4a.40.2';
    const mimeType = `video/mp4; codecs="${codecs}"`;
    if (!MediaSource.isTypeSupported(mimeType)) { alert(`지원되지 않는 코덱: ${mimeType}`); return; }

    const overlay = document.createElement('div');
    overlay.id = 'cc-cp-overlay';
    overlay.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:720px;max-width:90vw;background:#000;border:2px solid #1AE192;border-radius:8px;z-index:999999;box-shadow:0 8px 30px rgba(0,0,0,0.8);';
    const totalDurEst = Math.round(segMap.size * 2);
    const minutes = Math.floor(totalDurEst / 60), seconds = totalDurEst % 60;
    const durLabel = minutes > 0 ? `${minutes}분 ${seconds}초` : `${seconds}초`;
    overlay.innerHTML = `
      <div id="cc-cp-head" style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:#1a1a1a;cursor:move;">
        <span style="color:#1AE192;font-weight:700;">⏪ 되돌아가기 ${height}p · 재생 가능 ${durLabel} (${segMap.size}개 segment)</span>
        <button id="cc-cp-close" style="background:#e04545;color:#fff;border:none;border-radius:3px;padding:4px 12px;cursor:pointer;">✕ 닫기</button>
      </div>
      <video id="cc-cp-video" preload="auto" muted playsinline style="width:100%;height:400px;display:block;background:#222;object-fit:contain;cursor:pointer;"></video>
      <div style="padding:6px 12px;background:#1a1a1a;display:flex;align-items:center;gap:8px;">
        <button id="cc-cp-play" style="background:#1AE192;color:#111;border:none;border-radius:3px;padding:4px 10px;cursor:pointer;font-weight:700;width:36px;">▶</button>
        <button id="cc-cp-mute" style="background:transparent;border:1px solid #555;color:#ccc;border-radius:3px;padding:4px 6px;cursor:pointer;font-size:12px;width:34px;">🔇</button>
        <input id="cc-cp-vol" type="range" min="0" max="100" value="80" style="width:80px;height:4px;cursor:pointer;">
        <span id="cc-cp-time" style="color:#ccc;font-size:11px;font-family:monospace;white-space:nowrap;">00:00 / 00:00</span>
        <span id="cc-cp-wall" style="color:#888;font-size:10px;font-family:monospace;white-space:nowrap;"></span>
        <div id="cc-cp-bar" style="flex:1;height:10px;background:#333;border-radius:5px;cursor:pointer;position:relative;">
          <div id="cc-cp-bar-buf" style="position:absolute;top:0;left:0;height:100%;background:#555;border-radius:5px;width:0;"></div>
          <div id="cc-cp-bar-cur" style="position:absolute;top:0;left:0;height:100%;background:#1AE192;border-radius:5px;width:0;"></div>
        </div>
      </div>
      <div style="padding:6px 12px;background:#1a1a1a;color:#888;font-size:10px;display:flex;justify-content:space-between;">
        <span id="cc-cp-status">init segment 로딩 중...</span>
        <span id="cc-cp-progress" style="color:#1AE192;">0/${segMap.size}</span>
      </div>
    `;
    document.body.appendChild(overlay);
    enableOverlayDrag(overlay, overlay.querySelector('#cc-cp-head'));
    overlay.querySelector('#cc-cp-close').addEventListener('click', closeRewindPlayer);

    const videoEl = overlay.querySelector('#cc-cp-video');
    const statusEl = overlay.querySelector('#cc-cp-status');
    const progressEl = overlay.querySelector('#cc-cp-progress');

    const ms = new MediaSource();
    videoEl.src = URL.createObjectURL(ms);
    const appendedSeqs = new Set(); // 이미 SourceBuffer에 append한 seq들
    let sb;
    let cpHeight = height; // 캡처 시점 화질 (변경 안 됨)
    function getPendingSegs() {
      // accumSegsByHeight에서 아직 append 안 한 seq들을 정렬해서 반환
      const sm = accumSegsByHeight.get(cpHeight);
      if (!sm) return [];
      const out = [];
      for (const seq of [...sm.keys()].sort((a, b) => a - b)) {
        if (!appendedSeqs.has(seq)) out.push([seq, sm.get(seq)]);
      }
      return out;
    }
    ms.addEventListener('sourceopen', async () => {
      try {
        sb = ms.addSourceBuffer(mimeType);
        statusEl.textContent = 'init segment 로딩 중...';
        try {
          const fullInitUrl = withBgda(initUrl);
          const initBuf = await bgFetchBin(fullInitUrl);
          await appendBufAsync(sb, initBuf);
        } catch (e) {
          console.error('[cc-cp] init load fail', e);
          statusEl.textContent = '❌ init 로드 실패: ' + e.message;
          return;
        }
        // 초기 segment 로드해서 재생 시작 (최대 15개 = 30초 분량)
        const initialPending = getPendingSegs().slice(0, 15);
        for (let i = 0; i < initialPending.length; i++) {
          const [seq, url] = initialPending[i];
          try {
            const fullUrl = withBgda(url);
            const buf = await bgFetchBin(fullUrl);
            await appendBufAsync(sb, buf);
            appendedSeqs.add(seq);
            progressEl.textContent = `${appendedSeqs.size}개 로드됨`;
          } catch (e) { console.error('[cc-cp] seg', seq, 'fail:', e); }
        }
        // buffered 시작점으로 seek (fMP4 PDT로 인해 timeline이 절대 시각 기준)
        if (videoEl.buffered.length > 0) {
          const startT = videoEl.buffered.start(0);
          videoEl.currentTime = startT;
        }
        statusEl.textContent = '재생 중 (점진적 로딩)';
        videoEl.addEventListener('error', (e) => {
          console.error('[cc-cp] video error:', videoEl.error?.code, videoEl.error?.message);
          statusEl.textContent = '❌ 비디오 에러: ' + (videoEl.error?.message || 'unknown');
        });
        try {
          await videoEl.play();
        } catch (e) {
          console.warn('[cc-cp] autoplay blocked:', e.message);
          statusEl.textContent = '⚠ 클릭해서 재생하세요';
        }

        // 라이브 따라잡기: 새 chunklist로부터 도착하는 segment도 계속 추가
        const KEEP_AHEAD_SEC = 30; // 30초 이상 미리 버퍼되어 있으면 대기
        const KEEP_BEHIND_SEC = 3600; // 현재 시점 기준 1시간 이전은 버퍼에서 제거
        let loadMoreBusy = false;
        async function loadMore() {
          if (loadMoreBusy || !sb || sb.updating || stopped) return;
          const buffered = videoEl.buffered;
          if (buffered.length > 0) {
            const ahead = buffered.end(buffered.length - 1) - videoEl.currentTime;
            if (ahead > KEEP_AHEAD_SEC) return;
          }
          const pending = getPendingSegs();
          if (pending.length === 0) return;
          loadMoreBusy = true;
          const [seq, url] = pending[0];
          try {
            const buf = await bgFetchBin(withBgda(url));
            if (!sb || stopped) return;
            await appendBufAsync(sb, buf);
            appendedSeqs.add(seq);
            progressEl.textContent = `${appendedSeqs.size}개 (라이브 따라잡는 중)`;
          } catch (e) {
            console.warn('[cc-cp] loadMore fail seq=', seq, e);
          } finally {
            loadMoreBusy = false;
          }
        }
        // 오래된 segment 버퍼 trim (메모리 관리)
        async function trimOld() {
          if (sb.updating || !videoEl.buffered.length) return;
          const start = videoEl.buffered.start(0);
          const cutoff = videoEl.currentTime - KEEP_BEHIND_SEC;
          if (cutoff > start + 10) {
            try {
              await new Promise((res, rej) => {
                const onU = () => { sb.removeEventListener('updateend', onU); res(); };
                sb.addEventListener('updateend', onU);
                sb.remove(start, cutoff);
              });
            } catch (_) {}
          }
        }
        let stopped = false;
        const pollIv = setInterval(() => {
          if (stopped) { clearInterval(pollIv); return; }
          loadMore();
          trimOld();
        }, 1000);
        // seq ↔ currentTime 매핑: chzzk fMP4 timeline은 seq * segDur 기준
        // 첫 append된 (seq, t) anchor를 기준으로 linear 변환
        let anchorSeq = null, anchorT = null, segDur = 2;
        function recordAnchor() {
          if (anchorSeq !== null || !videoEl.buffered.length || !appendedSeqs.size) return;
          anchorSeq = Math.min(...appendedSeqs);
          anchorT = videoEl.buffered.start(0);
          // 두 개 이상 있으면 segDur 추정
          if (appendedSeqs.size >= 2 && videoEl.buffered.end(0) > anchorT) {
            segDur = (videoEl.buffered.end(0) - anchorT) / appendedSeqs.size;
          }
        }
        function tToSeq(t) {
          if (anchorSeq === null) return null;
          return Math.round(anchorSeq + (t - anchorT) / segDur);
        }
        recordAnchor();

        // Custom controls: 사용 가능한 segment 범위만 progress bar에 표시
        const playBtn = overlay.querySelector('#cc-cp-play');
        const muteBtn = overlay.querySelector('#cc-cp-mute');
        const volEl = overlay.querySelector('#cc-cp-vol');
        const timeLabel = overlay.querySelector('#cc-cp-time');
        const wallLabel = overlay.querySelector('#cc-cp-wall');
        videoEl.volume = 0.8;
        function syncMuteBtn() { muteBtn.textContent = videoEl.muted || videoEl.volume === 0 ? '🔇' : '🔊'; }
        syncMuteBtn();
        muteBtn.addEventListener('click', () => { videoEl.muted = !videoEl.muted; syncMuteBtn(); });
        volEl.addEventListener('input', () => { videoEl.volume = parseInt(volEl.value) / 100; if (videoEl.volume > 0) videoEl.muted = false; syncMuteBtn(); });
        // t → 방송 경과 시간 (seq × segDur 초). 방송 시작=0 가정 (chzzk seq는 방송 시작부터 증가)
        function tToBroadcastElapsedSec(t) {
          const seq = tToSeq(t);
          if (seq === null) return null;
          return seq * segDur;
        }
        function fmtHMS(sec) {
          if (sec == null || !isFinite(sec) || sec < 0) return '00:00:00';
          const h = Math.floor(sec / 3600);
          const m = Math.floor((sec % 3600) / 60);
          const s = Math.floor(sec % 60);
          return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        }
        const barEl = overlay.querySelector('#cc-cp-bar');
        const barBufEl = overlay.querySelector('#cc-cp-bar-buf');
        const barCurEl = overlay.querySelector('#cc-cp-bar-cur');
        function seqToT(seq) {
          if (anchorSeq === null) return 0;
          return anchorT + (seq - anchorSeq) * segDur;
        }
        function getAvailableRange() {
          const sm = accumSegsByHeight.get(cpHeight);
          if (!sm || !sm.size || anchorSeq === null) return [0, 0];
          const seqs = [...sm.keys()];
          return [seqToT(Math.min(...seqs)), seqToT(Math.max(...seqs)) + segDur];
        }
        function fmtT(s) {
          if (!isFinite(s) || s < 0) s = 0;
          const m = Math.floor(s / 60), sec = Math.floor(s % 60);
          return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
        }
        function updateCustomUi() {
          const [startT, endT] = getAvailableRange();
          const span = Math.max(endT - startT, 1);
          const cur = videoEl.currentTime;
          const curRel = Math.max(0, Math.min(cur - startT, span));
          barCurEl.style.width = `${(curRel / span) * 100}%`;
          let bufEnd = startT;
          for (let i = 0; i < videoEl.buffered.length; i++) bufEnd = Math.max(bufEnd, videoEl.buffered.end(i));
          const bufRel = Math.max(0, Math.min(bufEnd - startT, span));
          barBufEl.style.width = `${(bufRel / span) * 100}%`;
          timeLabel.textContent = `${fmtT(curRel)} / ${fmtT(span)}`;
          const curBc = tToBroadcastElapsedSec(cur);
          const endBc = tToBroadcastElapsedSec(endT);
          if (curBc != null && endBc != null) wallLabel.textContent = `📡 방송 ${fmtHMS(curBc)} / ${fmtHMS(endBc)}`;
          playBtn.textContent = videoEl.paused ? '▶' : '⏸';
          // seekable 범위를 누적된 전체로 확장 (안 그러면 video element가 buffered.end로 clamp)
          if (ms.readyState === 'open' && endT > startT) {
            try { ms.setLiveSeekableRange(startT, endT); } catch (_) {}
          }
        }
        const uiIv = setInterval(updateCustomUi, 250);
        playBtn.addEventListener('click', () => {
          if (videoEl.paused) videoEl.play(); else videoEl.pause();
        });
        videoEl.addEventListener('click', () => {
          if (videoEl.paused) videoEl.play(); else videoEl.pause();
        });
        barEl.addEventListener('click', (e) => {
          const [startT, endT] = getAvailableRange();
          const r = barEl.getBoundingClientRect();
          const frac = (e.clientX - r.left) / r.width;
          videoEl.currentTime = startT + frac * (endT - startT);
        });
        overlay.addEventListener('cc-cp-cleanup', () => clearInterval(uiIv));
        // seek 시 buffered 범위 밖이면 그 시각의 segment를 찾아 로드
        async function handleSeek() {
          if (!sb || stopped || sb.updating) return;
          const t = videoEl.currentTime;
          const buffered = videoEl.buffered;
          let isInBuffered = false;
          for (let i = 0; i < buffered.length; i++) {
            if (t >= buffered.start(i) && t <= buffered.end(i)) { isInBuffered = true; break; }
          }
          if (isInBuffered) return loadMore();
          const sm = accumSegsByHeight.get(cpHeight);
          if (!sm) return;
          const targetSeq = tToSeq(t);
          if (targetSeq === null) return;
          const sortedSeqs = [...sm.keys()].sort((a, b) => a - b);
          // targetSeq에 가장 가까운 실제 존재하는 seq 찾기
          let startIdx = sortedSeqs.findIndex(s => s >= targetSeq);
          if (startIdx === -1) startIdx = sortedSeqs.length - 1;
          if (startIdx > 0 && Math.abs(sortedSeqs[startIdx - 1] - targetSeq) < Math.abs(sortedSeqs[startIdx] - targetSeq)) startIdx--;
          for (let i = startIdx; i < Math.min(startIdx + 5, sortedSeqs.length); i++) {
            const sq = sortedSeqs[i];
            if (appendedSeqs.has(sq)) continue;
            try {
              const buf = await bgFetchBin(withBgda(sm.get(sq)));
              if (stopped) return;
              await appendBufAsync(sb, buf);
              appendedSeqs.add(sq);
              progressEl.textContent = `${appendedSeqs.size}개 (seek 로드)`;
            } catch (e) { console.warn('[cc-cp] seek seg fail seq=', sq, e); }
          }
        }
        videoEl.addEventListener('seeked', handleSeek);
        // overlay 닫힐 때 polling 종료
        overlay.addEventListener('cc-cp-cleanup', () => { stopped = true; });
      } catch (e) {
        statusEl.textContent = '❌ MSE 에러: ' + e.message;
      }
    });

    const btn = document.getElementById('cc-rewind-btn');
    if (btn) { btn.style.background = '#1AE192'; btn.style.color = '#111'; btn.textContent = '⏏'; }
  }

  // ===== 다중 채널 시청 (MVP) =====
  // 다른 채널의 라이브 스트림을 별도 패널로 띄움
  async function fetchLiveMasterUrl(cid) {
    // service/v3/channels/{cid}/live-detail이 더 풍부한 정보 (livePlaybackJson 포함)
    const r = await fetch(`https://api.chzzk.naver.com/service/v3/channels/${cid}/live-detail`, { credentials: 'include', cache: 'no-store' });
    if (!r.ok) throw new Error('live-detail ' + r.status);
    const j = await r.json();
    const c = j?.content;
    if (!c) throw new Error('content 없음 (code: ' + j?.code + ')');
    if (c.adult) throw new Error('성인 인증 필요한 방송');
    if (!c.livePlaybackJson) throw new Error(`방송 중이 아닙니다 (status: ${c.status || '?'})`);
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
    const segs = []; // {seq, url}
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
        const fn = l.split('?')[0];
        const seq = parseSegSeqFromName(fn) || mediaSeq;
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

    async function startVariant(variant) {
      await cleanupSession();
      if (stopped) return;
      statusEl.textContent = `${variant.height}p 로딩…`;
      const session = { stop: false, iv: null };
      currentSession = session;
      try {
        const chunklistUrl = new URL(variant.url, info.masterUrl).toString();
        const firstText = await bgFetchText(chunklistUrl);
        if (session.stop || stopped) return;
        const { initUrl, segs } = parseChunklistText(firstText, chunklistUrl);
        if (!initUrl || !segs.length) throw new Error('chunklist 빈 응답');

        let panelBgda = null;
        try { panelBgda = new URL(segs[0].url).searchParams.get('__bgda__'); } catch (_) {}
        const withPanelBgda = (u) => {
          if (!panelBgda) return u;
          try { const x = new URL(u); if (!x.searchParams.has('__bgda__')) x.searchParams.set('__bgda__', panelBgda); return x.toString(); }
          catch (_) { return u; }
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
        session.iv = setInterval(async () => {
          if (session.stop || stopped || busy) return;
          busy = true;
          try {
            const t = await bgFetchText(chunklistUrl);
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

  function tsFromFilename(filename) {
    // 파일명 패턴: {q}p_{salt}_{tsMs}_{...}.m4v
    const m = filename.match(/^\d+p_\d+_(\d+)_/);
    return m ? parseInt(m[1]) : null;
  }

  function getDvrRange() {
    let earliest = null, latest = null;
    // 1순위: 누적된 URL들의 timestamp 범위
    for (const [, segMap] of accumSegsByHeight) {
      for (const url of segMap.values()) {
        const fn = url.split('?')[0].split('/').pop();
        const ts = tsFromFilename(fn);
        if (!ts) continue;
        if (earliest === null || ts < earliest) earliest = ts;
        if (latest === null || ts > latest) latest = ts;
      }
    }
    // 2순위: chunklist text의 PROGRAM-DATE-TIME (보강)
    for (const [, text] of lastChunklistTextByHeight) {
      const pdts = [...text.matchAll(/#EXT-X-PROGRAM-DATE-TIME:(\S+)/g)].map((m) => new Date(m[1]).getTime()).filter((t) => Number.isFinite(t));
      if (!pdts.length) continue;
      if (earliest === null || pdts[0] < earliest) earliest = pdts[0];
      if (latest === null || pdts[pdts.length - 1] > latest) latest = pdts[pdts.length - 1];
    }
    return { earliest, latest };
  }

  function fmtMin(seconds) {
    const m = Math.floor(seconds / 60), s = seconds % 60;
    if (seconds >= 3600) {
      const h = Math.floor(seconds / 3600), mm = Math.floor((seconds % 3600) / 60);
      return `${h}:${String(mm).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function showRewindBar() {
    const panel = document.getElementById('cc-followings-panel');
    if (!panel) return;
    const { earliest, latest } = getDvrRange();
    if (!earliest || !latest || latest - earliest < 30000) {
      alert('되돌릴 수 있는 구간이 없거나 너무 짧습니다.\n(DVR 방송이 아닐 수 있어요)\n\nConsole에서 자세한 정보 확인 가능 (filter: cc-rewind)');
      return;
    }
    const totalSec = Math.floor((latest - earliest) / 1000);
    document.getElementById('cc-rewind-bar')?.remove();
    const bar = document.createElement('div');
    bar.id = 'cc-rewind-bar';
    bar.style.cssText = 'padding:8px 10px;background:rgba(26,225,146,0.08);border-top:1px solid rgba(26,225,146,0.3);border-bottom:1px solid rgba(26,225,146,0.3);font-size:11px;color:#fff;';
    bar.innerHTML = `
      <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
        <span style="font-weight:600;">⏪ 라이브 되돌리기</span>
        <button id="cc-rewind-close" type="button" style="background:transparent;border:none;color:#aaa;cursor:pointer;font-size:14px;padding:0 4px;">✕</button>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:10px;color:#aaa;margin-bottom:4px;">
        <span>방송 시작</span>
        <span id="cc-rewind-pos" style="color:#1AE192;font-weight:600;">현재</span>
        <span>현재 (${fmtMin(totalSec)})</span>
      </div>
      <div id="cc-rewind-track" style="position:relative;height:12px;background:#2a2a32;border-radius:6px;cursor:pointer;">
        <div id="cc-rewind-played" style="position:absolute;left:0;top:0;bottom:0;width:100%;background:linear-gradient(90deg,#1AE192,#1AE192);border-radius:6px;opacity:0.3;"></div>
        <div id="cc-rewind-handle" style="position:absolute;right:0;top:50%;transform:translate(50%,-50%);width:14px;height:14px;border-radius:50%;background:#1AE192;box-shadow:0 0 6px #1AE192;"></div>
      </div>
      <div style="display:flex;gap:4px;margin-top:6px;flex-wrap:wrap;align-items:center;">
        <button class="cc-rewind-quick" data-sec="5" type="button" style="font-size:10px;padding:2px 6px;background:#2a2a32;color:#ccc;border:1px solid #444;border-radius:3px;cursor:pointer;">-5초</button>
        <button class="cc-rewind-quick" data-sec="30" type="button" style="font-size:10px;padding:2px 6px;background:#2a2a32;color:#ccc;border:1px solid #444;border-radius:3px;cursor:pointer;">-30초</button>
        <button class="cc-rewind-quick" data-sec="60" type="button" style="font-size:10px;padding:2px 6px;background:#2a2a32;color:#ccc;border:1px solid #444;border-radius:3px;cursor:pointer;">-1분</button>
        <button class="cc-rewind-quick" data-sec="300" type="button" style="font-size:10px;padding:2px 6px;background:#2a2a32;color:#ccc;border:1px solid #444;border-radius:3px;cursor:pointer;">-5분</button>
        <input id="cc-rewind-custom" type="number" min="1" placeholder="초" style="width:50px;font-size:10px;padding:2px 4px;background:#2a2a32;color:#eee;border:1px solid #444;border-radius:3px;">
        <button id="cc-rewind-custom-go" type="button" style="font-size:10px;padding:2px 6px;background:#1AE192;color:#111;border:none;border-radius:3px;cursor:pointer;">이동</button>
        <button id="cc-rewind-to-live" type="button" style="font-size:10px;padding:2px 6px;background:#e04545;color:#fff;border:none;border-radius:3px;cursor:pointer;margin-left:auto;">실시간으로</button>
      </div>
    `;
    const header = panel.querySelector('.cc-fp-header');
    if (header && header.nextSibling) header.parentNode.insertBefore(bar, header.nextSibling);
    else panel.insertBefore(bar, panel.firstChild);
    // 클릭으로 위치 선택 (1초 단위)
    const track = bar.querySelector('#cc-rewind-track');
    track.addEventListener('click', (e) => {
      const rect = track.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const sec = Math.round(totalSec * (1 - ratio));
      if (sec === 0) { clearRewind(); return; }
      rewindToSeconds(sec);
    });
    bar.querySelectorAll('.cc-rewind-quick').forEach((b) => {
      b.addEventListener('click', () => rewindToSeconds(parseInt(b.dataset.sec)));
    });
    bar.querySelector('#cc-rewind-custom-go').addEventListener('click', () => {
      const v = parseInt(bar.querySelector('#cc-rewind-custom').value);
      if (Number.isFinite(v) && v > 0) rewindToSeconds(v);
    });
    bar.querySelector('#cc-rewind-custom').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') bar.querySelector('#cc-rewind-custom-go').click();
    });
    bar.querySelector('#cc-rewind-to-live').addEventListener('click', clearRewind);
    bar.querySelector('#cc-rewind-close').addEventListener('click', () => {
      bar.remove();
      if (hijackActive) clearRewind();
    });
  }

  function updateRewindBar(seconds) {
    const bar = document.getElementById('cc-rewind-bar');
    if (!bar) return;
    const { earliest, latest } = getDvrRange();
    if (!earliest || !latest) return;
    const totalSec = Math.floor((latest - earliest) / 1000);
    const ratio = Math.max(0, Math.min(1, 1 - seconds / totalSec));
    const handle = bar.querySelector('#cc-rewind-handle');
    const played = bar.querySelector('#cc-rewind-played');
    const pos = bar.querySelector('#cc-rewind-pos');
    if (handle) { handle.style.right = ''; handle.style.left = (ratio * 100) + '%'; handle.style.transform = 'translate(-50%, -50%)'; }
    if (played) { played.style.width = (ratio * 100) + '%'; played.style.opacity = '0.6'; }
    const label = seconds >= 60 ? `${Math.floor(seconds / 60)}분 ${seconds % 60}초 전` : `${seconds}초 전`;
    if (pos) pos.textContent = label;
    const btn = document.getElementById('cc-rewind-btn');
    if (btn) { btn.style.background = '#e0a93b'; btn.style.color = '#111'; btn.title = `${label} 부터 재생 중 (클릭으로 패널 토글)`; btn.textContent = '⏸'; }
  }

  function buildRewoundChunklist(origText, baseUrl, minutes, height) {
    const lines = origText.split(/\r?\n/);
    // PROGRAM-DATE-TIME 기준으로 N분 전 위치 찾기
    const targetTs = Date.now() - minutes * 60 * 1000;
    let header = [];
    const entries = []; // { pdt, extinf, url, raw[] }
    let i = 0;
    // 헤더 (#EXT 시작 + STREAM-INF 같은 거 없는 줄들)
    while (i < lines.length) {
      const l = lines[i].trim();
      if (l.startsWith('#EXT-X-MAP') || (!l.startsWith('#') && l)) break;
      header.push(lines[i]);
      i++;
    }
    // EXT-X-MAP
    let mapLine = null;
    if (i < lines.length && lines[i].trim().startsWith('#EXT-X-MAP')) {
      mapLine = lines[i];
      i++;
    }
    // segments
    let pendingPdt = null;
    let pendingExtinf = null;
    let pendingMisc = [];
    while (i < lines.length) {
      const l = lines[i].trim();
      if (l.startsWith('#EXT-X-PROGRAM-DATE-TIME')) {
        pendingPdt = l;
      } else if (l.startsWith('#EXTINF')) {
        pendingExtinf = l;
      } else if (l.startsWith('#EXT')) {
        pendingMisc.push(l);
      } else if (l && !l.startsWith('#')) {
        // segment URL
        const pdtMatch = pendingPdt?.match(/PROGRAM-DATE-TIME:(.+)$/);
        const tsValue = pdtMatch ? new Date(pdtMatch[1]).getTime() : null;
        entries.push({ pdt: pendingPdt, extinf: pendingExtinf, misc: pendingMisc, url: l, ts: tsValue });
        pendingPdt = null;
        pendingExtinf = null;
        pendingMisc = [];
      }
      i++;
    }
    // N분 전 이상 (오래된 쪽)부터 entries 잘라내기
    let startIdx = 0;
    for (let k = 0; k < entries.length; k++) {
      if (entries[k].ts && entries[k].ts >= targetTs) { startIdx = k; break; }
    }
    if (startIdx >= entries.length - 1) return null; // 그만큼 과거 없음
    const slice = entries.slice(startIdx);
    // MEDIA-SEQUENCE 재계산: 원본의 sequence 시작점 + startIdx
    const origSeqMatch = origText.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
    const origSeq = origSeqMatch ? parseInt(origSeqMatch[1]) : 0;
    const newSeq = origSeq + startIdx;
    // 헤더 재구성 (MEDIA-SEQUENCE만 갱신, LL-HLS blocking 관련 헤더 제거해서 단순화)
    const newHeader = header.map((l) => {
      if (l.startsWith('#EXT-X-MEDIA-SEQUENCE')) return `#EXT-X-MEDIA-SEQUENCE:${newSeq}`;
      if (l.startsWith('#EXT-X-SERVER-CONTROL') || l.startsWith('#EXT-X-PART-INF')) return null;
      return l;
    }).filter((l) => l !== null);
    const out = [];
    out.push(...newHeader);
    if (mapLine) out.push(mapLine);
    for (const e of slice) {
      if (e.pdt) out.push(e.pdt);
      if (e.extinf) out.push(e.extinf);
      for (const m of e.misc) out.push(m);
      out.push(e.url);
    }
    return out.join('\n');
  }
  // ───── (이전 DVR download 코드 시작 — 보존) ─────
  let dvrBusy = false;
  async function downloadDvr() {
    if (dvrBusy) { alert('이미 다운로드 진행 중입니다.'); return; }
    if (!chunklistUrl) { alert('chunklist URL이 아직 캡처되지 않았습니다. 영상을 한 번 재생해주세요.'); return; }
    if (!bgdaToken) { alert('인증 토큰이 아직 캡처되지 않았습니다. 영상을 한 번 재생해주세요.'); return; }
    dvrBusy = true;
    const btn = document.getElementById('cc-dvr-dl-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ chunklist 분석…'; }
    try {
      const text = await bgFetchText(chunklistUrl);
      const { initUrl, segs } = parseMedia(text, chunklistUrl);
      // PROGRAM-DATE-TIME 첫 줄로 방송 시작 후 경과 시간 추정
      const pdtMatch = text.match(/#EXT-X-DATERANGE:[^\n]*START-DATE="([^"]+)"/);
      const startDate = pdtMatch ? new Date(pdtMatch[1]) : null;
      const totalDur = segs.length * 2; // 대략 (정확히는 EXTINF 합)
      const minutes = Math.floor(totalDur / 60);
      if (!segs.length) throw new Error('chunklist에 segment가 없음');
      if (!confirm(`방송 시작부터 현재까지 약 ${minutes}분 (${segs.length}개 segment) 다운로드합니다.\n메모리 사용량 큼. 계속하시겠습니까?`)) {
        if (btn) { btn.disabled = false; btn.textContent = '📥 DVR 받기'; }
        dvrBusy = false;
        return;
      }
      const { channelName, fullTitle: title } = getChannelInfo();
      const heightMatch = chunklistUrl.match(/\/(\d+)p\//);
      const height = heightMatch ? parseInt(heightMatch[1]) : null;
      const buffers = [];
      let initBuf = null;
      let totalBytes = 0;
      let done = 0;
      const total = segs.length + (initUrl ? 1 : 0);
      const update = () => {
        if (btn) btn.textContent = `📥 ${done}/${total} (${((totalBytes/1e6).toFixed(0))}MB)`;
      };
      if (initUrl) {
        try {
          initBuf = await bgFetchBin(withBgda(initUrl));
          totalBytes += initBuf.byteLength;
          done++;
          update();
        } catch (_) {}
      }
      // 병렬 다운로드 (concurrency 8)
      const concurrency = 8;
      let next = 0;
      async function worker() {
        while (next < segs.length) {
          const i = next++;
          if (!segs[i]) continue;
          try {
            const buf = await bgFetchBin(withBgda(segs[i]));
            buffers[i] = buf;
            totalBytes += buf.byteLength;
          } catch (_) {}
          done++;
          if (done % 5 === 0) update();
        }
      }
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      update();
      if (btn) btn.textContent = '📦 파일 생성 중…';
      const all = initBuf ? [initBuf, ...buffers.filter(Boolean)] : buffers.filter(Boolean);
      const blob = new Blob(all, { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);
      const filename = `${sanitize(title)}_${height || '?'}p_dvr_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.mp4`;
      await chrome.runtime.sendMessage({ type: 'cc-download', url, filename });
      if (btn) btn.textContent = `✓ ${fmtBytes(blob.size)}`;
      setTimeout(() => { URL.revokeObjectURL(url); if (btn) { btn.disabled = false; btn.textContent = '📥 DVR 받기'; } dvrBusy = false; }, 5000);
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = '❌ ' + e.message; }
      setTimeout(() => { if (btn) btn.textContent = '📥 DVR 받기'; }, 3000);
      dvrBusy = false;
    }
  }

  function ensureStatusRow() {
    const panel = document.getElementById('cc-followings-panel');
    if (!panel) return null;
    let row = document.getElementById('cc-live-rec-status');
    if (row) return row;
    row = document.createElement('div');
    row.id = 'cc-live-rec-status';
    row.style.cssText = 'display:flex;gap:10px;align-items:center;padding:6px 10px;background:rgba(224,69,69,0.18);border-top:1px solid rgba(224,69,69,0.4);border-bottom:1px solid rgba(224,69,69,0.4);font-size:11px;color:#fff;';
    row.innerHTML = `
      <div style="display:flex;gap:10px;align-items:center;width:100%;">
        <span style="display:inline-flex;align-items:center;gap:4px;flex-shrink:0;"><span style="width:8px;height:8px;border-radius:50%;background:#e04545;display:inline-block;box-shadow:0 0 6px #e04545;animation:cc-rec-pulse 1.2s infinite;"></span>REC</span>
        <span class="cc-rec-channel" style="font-weight:700;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:90px;">-</span>
        <span class="cc-rec-quality" style="color:#1AE192;font-weight:600;flex-shrink:0;">-</span>
        <span class="cc-rec-time" style="font-family:monospace;font-weight:600;flex-shrink:0;">0:00</span>
        <span class="cc-rec-size" style="flex-shrink:0;">-</span>
        <span class="cc-rec-chunks" style="color:#aaa;margin-left:auto;flex-shrink:0;">-</span>
      </div>
      <div style="font-size:10px;color:#ffb84d;margin-top:2px;width:100%;">⚠ 페이지 이동 시 녹화가 종료되고 받은 데이터가 사라집니다</div>
    `;
    row.style.flexDirection = 'column';
    row.style.alignItems = 'stretch';
    if (!document.getElementById('cc-rec-pulse-style')) {
      const st = document.createElement('style');
      st.id = 'cc-rec-pulse-style';
      st.textContent = '@keyframes cc-rec-pulse { 0%,100% { opacity:1 } 50% { opacity:0.3 } }';
      document.head.appendChild(st);
    }
    const header = panel.querySelector('.cc-fp-header');
    if (header && header.nextSibling) header.parentNode.insertBefore(row, header.nextSibling);
    else panel.insertBefore(row, panel.firstChild);
    return row;
  }
  function removeStatusRow() { document.getElementById('cc-live-rec-status')?.remove(); }

  // 다른 탭의 녹화 상태 표시용 list row
  async function refreshOtherRecsRow() {
    const panel = document.getElementById('cc-followings-panel');
    if (!panel) return;
    const list = await getActiveRecordings();
    const others = list.filter((x) => x.id !== myRecId);
    let row = document.getElementById('cc-other-recs');
    if (!others.length) { row?.remove(); return; }
    if (!row) {
      row = document.createElement('div');
      row.id = 'cc-other-recs';
      row.style.cssText = 'padding:4px 10px;background:rgba(224,69,69,0.08);border-bottom:1px solid rgba(224,69,69,0.25);font-size:10px;color:#ccc;display:flex;align-items:center;gap:6px;flex-wrap:wrap;';
      const status = document.getElementById('cc-live-rec-status');
      const anchor = status || panel.querySelector('.cc-fp-header');
      if (status) status.parentNode.insertBefore(row, status.nextSibling);
      else if (anchor && anchor.nextSibling) anchor.parentNode.insertBefore(row, anchor.nextSibling);
      else panel.insertBefore(row, panel.firstChild);
    }
    const now = Date.now();
    row.innerHTML = `<span style="color:#e0a93b;flex-shrink:0;">🔴 다른 탭:</span>` + others.map((x) => {
      const elapsed = Math.floor((now - x.startedAt) / 1000);
      const h = Math.floor(elapsed / 3600), m = Math.floor((elapsed % 3600) / 60), s = elapsed % 60;
      const pad = (n) => String(n).padStart(2, '0');
      const t = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
      return `<span title="${x.channelName}" style="background:rgba(224,69,69,0.25);padding:2px 6px;border-radius:3px;">${(x.channelName || '?').slice(0, 12)} <span style="font-family:monospace;color:#fff;">${t}</span></span>`;
    }).join('');
  }
  const _otherIv = setInterval(() => {
    if (ctxInvalid) { clearInterval(_otherIv); return; }
    refreshOtherRecsRow();
  }, 2000);

  let lastSeenCid = null;
  function ensureUi() {
    const cid = liveCid();
    if (cid !== lastSeenCid) {
      // 채널 이동 → 이전 cid 데이터 저장 후, 새 cid 데이터 로드
      if (lastSeenCid !== null && !recState) {
        accumSegsByHeight.clear();
        accumInitByHeight.clear();
        lastChunklistTextByHeight.clear();
        lastChunklistBaseUrlByHeight.clear();
        bgdaToken = null;
        chunklistUrl = null;
        masterUrl = null;
        document.getElementById('cc-cp-overlay')?.remove();
      }
      lastSeenCid = cid;
    }
    if (!cid && !recState) {
      document.getElementById('cc-live-rec-wrap')?.remove();
      return;
    }
    const header = document.querySelector('#cc-followings-panel .cc-fp-header');
    if (!header) return;
    if (header.querySelector('#cc-live-rec-wrap')) { updateUi(); return; }
    const wrap = document.createElement('span');
    wrap.id = 'cc-live-rec-wrap';
    wrap.style.cssText = 'display:inline-flex;align-items:center;';
    wrap.innerHTML = `
      <button id="cc-rewind-btn" type="button" class="cc-icon-btn" title="라이브 되돌리기 (DVR 방송 한정)" style="font-size:12px;padding:2px 6px;">⏪</button>
      <button id="cc-multi-btn" type="button" class="cc-icon-btn" title="다른 채널 라이브 추가 시청" style="font-size:13px;">📺</button>
      <button id="cc-live-rec-btn" type="button" class="cc-icon-btn" title="라이브 녹화 (player 현재 화질로 녹화)" style="font-size:13px;">🔴</button>
    `;
    wrap.style.gap = '4px';
    // 라이브 관련 버튼들은 row1이 아닌 row2 (필터 영역)에 배치 — row2는 flex-wrap:wrap이라 좁을 때 자동 줄바꿈
    const row2 = header.querySelector('.cc-fp-row2');
    const refreshBtn = header.querySelector('.cc-fp-refresh');
    if (row2) row2.appendChild(wrap);
    else if (refreshBtn) refreshBtn.parentElement.insertBefore(wrap, refreshBtn);
    else header.appendChild(wrap);
    wrap.querySelector('#cc-rewind-btn').addEventListener('click', () => {
      const existing = document.getElementById('cc-cp-overlay');
      if (existing) closeRewindPlayer();
      else showRewindPlayer();
    });
    wrap.querySelector('#cc-multi-btn').addEventListener('click', openChannelPicker);
    wrap.querySelector('#cc-live-rec-btn').addEventListener('click', () => {
      if (recState) {
        if (confirm('녹화를 중지하고 저장하시겠습니까?')) recState.stop();
        return;
      }
      startRecording();
    });
    updateUi();
  }
  function updateUi() {
    const btn = document.getElementById('cc-live-rec-btn');
    if (!btn) return;
    if (recState) {
      btn.style.background = '#e04545';
      btn.style.color = '#fff';
      btn.style.borderColor = '#e04545';
      btn.style.opacity = '1';
      btn.title = '클릭해서 녹화 중지 및 저장';
      btn.textContent = '⏹';
    } else {
      btn.style.background = '';
      btn.style.color = '';
      btn.style.borderColor = '';
      btn.style.opacity = '1';
      btn.title = '라이브 녹화 (player 현재 화질로 녹화)';
      btn.textContent = '🔴';
    }
  }

  const _uiIv = setInterval(() => {
    if (ctxInvalid) { clearInterval(_uiIv); return; }
    ensureUi();
  }, 2000);
  ensureUi();
  getActiveRecordings().catch(() => {});

  // 디버그용: 누적된 URL 상태 확인 + 가장 오래된 segment fetch 테스트
  window.__ccRecDebug = {
    showAccum() {
      const out = {};
      for (const [h, segMap] of accumSegsByHeight) {
        const seqs = [...segMap.keys()].sort((a, b) => a - b);
        out[h + 'p'] = {
          count: segMap.size,
          oldestSeq: seqs[0],
          newestSeq: seqs[seqs.length - 1],
          spanSec: (seqs.length - 1) * 2,
          oldestUrl: segMap.get(seqs[0]),
        };
      }
      console.table(out);
      console.log('bgdaToken:', bgdaToken ? '있음' : '없음');
      return out;
    },
    async testOldest(height) {
      const h = height || [...accumSegsByHeight.keys()].sort((a,b)=>b-a)[0];
      if (!h) { console.log('누적된 URL 없음'); return; }
      const segMap = accumSegsByHeight.get(h);
      const seqs = [...segMap.keys()].sort((a, b) => a - b);
      const oldestSeq = seqs[0];
      const newestSeq = seqs[seqs.length - 1];
      const ageSec = (newestSeq - oldestSeq) * 2;
      const url = segMap.get(oldestSeq);
      console.log(`[${h}p] 가장 오래된 segment: seq=${oldestSeq}, 약 ${Math.floor(ageSec/60)}분 ${ageSec%60}초 전`);
      console.log('URL:', url);
      try {
        const buf = await bgFetchBin(url + (url.includes('?') ? '&' : '?') + '__bgda__=' + encodeURIComponent(bgdaToken || ''));
        console.log(`✅ 성공! ${(buf.byteLength/1024).toFixed(1)} KB 받음`);
        return { ok: true, size: buf.byteLength, ageSec };
      } catch (e) {
        console.log(`❌ 실패: ${e.message}`);
        return { ok: false, error: e.message, ageSec };
      }
    },
    async testAll(height) {
      const h = height || [...accumSegsByHeight.keys()].sort((a,b)=>b-a)[0];
      if (!h) return;
      const segMap = accumSegsByHeight.get(h);
      const seqs = [...segMap.keys()].sort((a, b) => a - b);
      let ok = 0, fail = 0;
      // 5개 균등 샘플링
      const sample = [];
      const step = Math.max(1, Math.floor(seqs.length / 5));
      for (let i = 0; i < seqs.length; i += step) sample.push(seqs[i]);
      const newestSeq = seqs[seqs.length - 1];
      for (const seq of sample) {
        const url = segMap.get(seq);
        const ageSec = (newestSeq - seq) * 2;
        try {
          await bgFetchBin(url + (url.includes('?') ? '&' : '?') + '__bgda__=' + encodeURIComponent(bgdaToken || ''));
          console.log(`✅ seq=${seq} (${Math.floor(ageSec/60)}분 전): OK`);
          ok++;
        } catch (e) {
          console.log(`❌ seq=${seq} (${Math.floor(ageSec/60)}분 전): ${e.message}`);
          fail++;
        }
      }
      console.log(`결과: ${ok} 성공 / ${fail} 실패`);
    },
  };
})();
