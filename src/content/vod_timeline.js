"use strict";
// 치지직 다시보기: 댓글 타임스탬프 → 진행바 마커. 클릭 시 제자리 이동(스크롤 안 튐).
const __cvtMain = () => {
  const SLIDER = ".pzp-ui-slider__wrap";

  const state = {
    videoId: null,
    entries: [],
    loading: false,
    error: null,
  };

  /* ---------- 유틸 ---------- */
  function currentVideoId() {
    const m = location.pathname.match(/\/video\/(\d+)/);
    return m ? m[1] : null;
  }

  function fmt(s) {
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const p = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
  }

  function getVideo() {
    return document.querySelector("video");
  }
  function getDuration() {
    const v = getVideo();
    return v && isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
  }

  function seek(sec) {
    const v = getVideo();
    if (!v) return;
    const dur = isFinite(v.duration) ? v.duration : sec;
    try {
      v.currentTime = Math.max(0, Math.min(sec, dur));
    } catch (e) {}
  }

  /* ---------- 댓글 내용에서 타임스탬프 추출 ---------- */
  // mm:ss 또는 h:mm:ss (초/분은 2자리). 줄 단위로 라벨 생성.
  function parseEntries(content, nickname, buff, commentId) {
    const out = [];
    if (!content) return out;
    const lines = content.split(/\r?\n/);
    const re = /(\d{1,2}):(\d{2})(?::(\d{2}))?/g;
    const stripRe = /\[?\(?\s*\d{1,2}:\d{2}(?::\d{2})?\s*\)?\]?/g;
    for (const line of lines) {
      re.lastIndex = 0;
      const secs = [];
      let m;
      while ((m = re.exec(line))) {
        let h = 0, mm = 0, ss = 0;
        if (m[3] !== undefined) {
          h = +m[1]; mm = +m[2]; ss = +m[3];
        } else {
          mm = +m[1]; ss = +m[2];
        }
        if (ss >= 60) continue;
        if (m[3] !== undefined && mm >= 60) continue;
        secs.push(h * 3600 + mm * 60 + ss);
      }
      if (!secs.length) continue;
      let label = line.replace(stripRe, " ").replace(/\s+/g, " ").trim();
      label = label.replace(/^[\s\-–—:·•.)\]>]+/, "").trim();
      for (const sec of secs) out.push({ sec, label, nickname, buff, commentId });
    }
    return out;
  }

  /* ---------- 댓글 API ---------- */
  // 응답 content 전체를 훑어 댓글 객체를 모음 (data / bestComments / 기타 위치 무관).
  function collectComments(node, acc, seen, depth) {
    if (!node || typeof node !== "object" || depth > 7) return;
    if (Array.isArray(node)) {
      for (const x of node) collectComments(x, acc, seen, depth + 1);
      return;
    }
    let c = null;
    if (node.comment && typeof node.comment.content === "string") c = node.comment;
    else if (typeof node.content === "string" && node.commentId != null) c = node;
    if (c && c.commentId != null && !seen.has(c.commentId)) {
      seen.add(c.commentId);
      acc.push(node.comment ? node : { comment: node });
    }
    for (const k in node) {
      const v = node[k];
      if (v && typeof v === "object") collectComments(v, acc, seen, depth + 1);
    }
  }

  async function fetchPage(id, offset, limit) {
    const url =
      `https://apis.naver.com/nng_main/nng_comment_api/v1/type/STREAMING_VIDEO/id/${id}` +
      `/comments?limit=${limit}&offset=${offset}&orderType=POPULAR&pagingType=PAGE`;
    const r = await fetch(url, {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    return j && j.content; // content 전체 (comments.data + bestComments 등)
  }

  async function fetchAllComments(id) {
    const limit = 30;
    const seen = new Set();
    const acc = [];
    const first = await fetchPage(id, 0, limit);
    if (!first) return [];
    collectComments(first, acc, seen, 0); // 일반 + 베스트 댓글 모두
    const cm = first.comments || {};
    const total = cm.totalCount || cm.commentCount || acc.length;
    const maxPages = 50; // 안전 상한 (≈1500개)
    const pages = Math.min(Math.ceil(total / limit), maxPages);
    for (let p = 1; p < pages; p++) {
      if (state.videoId !== id) return acc; // 다른 영상으로 이동됨
      try {
        const content = await fetchPage(id, p * limit, limit);
        const before = acc.length;
        collectComments(content, acc, seen, 0);
        const data = content && content.comments && content.comments.data;
        if ((!data || !data.length) && acc.length === before) break;
      } catch (e) {
        break;
      }
    }
    if (Math.ceil(total / limit) > maxPages) {
      console.log(`[VOD타임라인] 댓글 ${total}개 중 상위 ${maxPages * limit}개만 스캔`);
    }
    return acc;
  }

  function buildEntries(rawComments) {
    const entries = [];
    for (const item of rawComments) {
      const c = item && item.comment;
      if (!c || !c.content || c.deleted) continue;
      const nick = (item.user && item.user.userNickname) || "";
      const buff = (item.buffNerf && item.buffNerf.buffCount) || 0;
      for (const e of parseEntries(c.content, nick, buff, c.commentId)) entries.push(e);
    }
    entries.sort((a, b) => a.sec - b.sec);
    // sec+라벨 앞부분 동일하면 중복 제거
    const seen = new Set();
    const dedup = [];
    for (const e of entries) {
      const k = e.sec + "|" + (e.label || "").slice(0, 16);
      if (seen.has(k)) continue;
      seen.add(k);
      dedup.push(e);
    }
    return dedup.slice(0, 400);
  }

  /* ---------- 진행바 마커 ---------- */
  let tipEl = null;
  function showTip(anchor, e) {
    if (!tipEl) {
      tipEl = document.createElement("div");
      tipEl.className = "cvt-tip";
      document.body.appendChild(tipEl);
    }
    tipEl.textContent = "";
    const t = document.createElement("div");
    t.className = "cvt-tip-time";
    t.textContent = fmt(e.sec);
    const l = document.createElement("div");
    l.className = "cvt-tip-label";
    l.textContent = e.label || "(내용 없음)";
    const n = document.createElement("div");
    n.className = "cvt-tip-by";
    n.textContent = (e.nickname || "익명") + (e.buff ? `  ·  👍 ${e.buff}` : "");
    tipEl.append(t, l, n);

    const r = anchor.getBoundingClientRect();
    tipEl.style.display = "block";
    const tw = tipEl.offsetWidth;
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
    tipEl.style.left = left + "px";
    tipEl.style.top = Math.max(8, r.top - tipEl.offsetHeight - 10) + "px";
    tipEl.classList.add("show");
  }
  function hideTip() {
    if (tipEl) {
      tipEl.classList.remove("show");
      tipEl.style.display = "none";
    }
  }

  function ensureMarkerLayer() {
    const wrap = document.querySelector(SLIDER);
    if (!wrap) return null;
    if (getComputedStyle(wrap).position === "static") wrap.style.position = "relative";
    let layer = wrap.querySelector(":scope > .cvt-markers");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "cvt-markers";
      wrap.appendChild(layer);
    }
    return layer;
  }

  function renderMarkers() {
    const layer = ensureMarkerLayer();
    const dur = getDuration();
    if (!layer || !dur) return;
    layer.textContent = "";
    for (const e of state.entries) {
      if (e.sec > dur + 2) continue;
      const pct = Math.max(0, Math.min(100, (e.sec / dur) * 100));
      const mk = document.createElement("div");
      mk.className = "cvt-marker";
      mk.style.left = pct + "%";
      const stop = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
      mk.addEventListener("mousedown", stop, true);
      mk.addEventListener("click", (ev) => { stop(ev); seek(e.sec); });
      mk.addEventListener("mouseenter", () => showTip(mk, e));
      mk.addEventListener("mouseleave", hideTip);
      layer.appendChild(mk);
    }
    layer.dataset.dur = String(Math.round(dur));
    layer.dataset.n = String(layer.childElementCount);
  }

  function reconcileMarkers() {
    if (!state.entries.length) return;
    const wrap = document.querySelector(SLIDER);
    if (!wrap) return;
    const dur = getDuration();
    if (!dur) return;
    const layer = wrap.querySelector(":scope > .cvt-markers");
    if (!layer || layer.dataset.dur !== String(Math.round(dur)) || !layer.childElementCount) {
      renderMarkers();
    }
  }

  /* ---------- 추천순·작성자별 목록 패널 ---------- */
  let panel, panelBody, panelTitle, panelToggle;
  let drag = null;
  function ensurePanel() {
    if (panel) return panel;
    panel = document.createElement("div");
    panel.className = "cvt-panel";
    const head = document.createElement("div");
    head.className = "cvt-head";
    panelTitle = document.createElement("div");
    panelTitle.className = "cvt-title";
    panelTitle.textContent = "댓글 타임라인";
    panelToggle = document.createElement("button");
    panelToggle.className = "cvt-x";
    panelToggle.textContent = "—";
    panelToggle.title = "접기/펼치기";
    panelToggle.addEventListener("click", () => {
      panel.classList.toggle("collapsed");
      panelToggle.textContent = panel.classList.contains("collapsed") ? "▢" : "—";
    });
    // 헤더 드래그로 패널 이동
    head.addEventListener("mousedown", (e) => {
      if (e.target.closest(".cvt-x")) return; // 접기 버튼 제외
      const r = panel.getBoundingClientRect();
      panel.style.left = r.left + "px";
      panel.style.top = r.top + "px";
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      drag = { el: panel, sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top };
      document.body.style.userSelect = "none";
      e.preventDefault();
    });
    head.append(panelTitle, panelToggle);
    panelBody = document.createElement("div");
    panelBody.className = "cvt-body";
    panel.append(head, panelBody);
    document.body.appendChild(panel);
    return panel;
  }

  // 댓글(작성자)별로 묶고 추천순 정렬
  function groupEntries(entries) {
    const map = new Map();
    for (const e of entries) {
      let g = map.get(e.commentId);
      if (!g) {
        g = { commentId: e.commentId, nickname: e.nickname, buff: e.buff || 0, items: [] };
        map.set(e.commentId, g);
      }
      g.items.push(e);
    }
    const groups = [...map.values()];
    for (const g of groups) g.items.sort((a, b) => a.sec - b.sec);
    groups.sort((a, b) => b.buff - a.buff || a.items[0].sec - b.items[0].sec);
    return groups;
  }

  function cmsg(text) {
    const d = document.createElement("div");
    d.className = "cvt-msg";
    d.textContent = text;
    return d;
  }

  function renderPanel() {
    ensurePanel();
    const dur = getDuration();
    const entries = dur ? state.entries.filter((e) => e.sec <= dur + 2) : state.entries;
    panelBody.textContent = "";
    if (state.loading) {
      panel.style.display = "";
      panelTitle.textContent = "댓글 타임라인";
      panelBody.appendChild(cmsg("불러오는 중…"));
      return;
    }
    if (state.error) {
      panel.style.display = "";
      panelBody.appendChild(cmsg("댓글을 불러오지 못했습니다."));
      return;
    }
    if (!entries.length) {
      panel.style.display = "none";
      return;
    }
    panel.style.display = "";
    panelTitle.textContent = `댓글 타임라인 (${entries.length})`;
    for (const g of groupEntries(entries)) {
      const card = document.createElement("div");
      card.className = "cvt-group";
      const gh = document.createElement("div");
      gh.className = "cvt-gh";
      const chev = document.createElement("span");
      chev.className = "cvt-chev";
      chev.textContent = "▾";
      const nm = document.createElement("span");
      nm.className = "cvt-nick";
      nm.textContent = g.nickname || "익명";
      const cnt = document.createElement("span");
      cnt.className = "cvt-cnt";
      cnt.textContent = g.items.length + "개";
      const bf = document.createElement("span");
      bf.className = "cvt-buff";
      bf.textContent = "👍 " + g.buff;
      gh.append(chev, nm, cnt, bf);
      gh.addEventListener("click", () => {
        const c = card.classList.toggle("collapsed");
        chev.textContent = c ? "▸" : "▾";
      });
      card.appendChild(gh);
      for (const e of g.items) {
        const row = document.createElement("div");
        row.className = "cvt-item";
        const tb = document.createElement("span");
        tb.className = "cvt-time";
        tb.textContent = fmt(e.sec);
        const tx = document.createElement("span");
        tx.className = "cvt-label";
        tx.textContent = e.label || "바로 이동";
        row.append(tb, tx);
        row.title = e.label || "";
        row.addEventListener("click", () => seek(e.sec));
        card.appendChild(row);
      }
      panelBody.appendChild(card);
    }
  }

  /* ---------- 로드/해제 ---------- */
  async function loadVideo(id) {
    state.videoId = id;
    state.entries = [];
    state.error = null;
    state.loading = true;
    renderPanel();
    try {
      const raw = await fetchAllComments(id);
      if (state.videoId !== id) return;
      state.entries = buildEntries(raw);
      state.loading = false;
      console.log(`[VOD타임라인] 댓글 ${raw.length}개 → 타임스탬프 마커 ${state.entries.length}개`);
      renderMarkers();
      renderPanel();
    } catch (e) {
      if (state.videoId !== id) return;
      state.loading = false;
      state.error = e;
      console.log("[VOD타임라인] 댓글 로드 실패:", e);
      renderPanel();
    }
  }

  function teardown() {
    state.videoId = null;
    state.entries = [];
    if (panel) { panel.remove(); panel = null; }
    const layer = document.querySelector(SLIDER + " > .cvt-markers");
    if (layer) layer.remove();
    hideTip();
  }

  /* ---------- 메인 루프 (SPA 대응) ---------- */
  function tick() {
    const id = currentVideoId();
    if (!id) {
      if (state.videoId) teardown();
      return;
    }
    if (id !== state.videoId) {
      loadVideo(id);
    } else {
      reconcileMarkers();
    }
  }

  setInterval(tick, 1500);
  window.addEventListener("resize", () => { if (state.entries.length) renderMarkers(); });
  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    const el = drag.el, w = el.offsetWidth, h = el.offsetHeight;
    let nx = drag.ox + (e.clientX - drag.sx);
    let ny = drag.oy + (e.clientY - drag.sy);
    nx = Math.max(4, Math.min(nx, window.innerWidth - w - 4));
    ny = Math.max(4, Math.min(ny, window.innerHeight - h - 4));
    el.style.left = nx + "px";
    el.style.top = ny + "px";
  });
  window.addEventListener("mouseup", () => {
    if (drag) { drag = null; document.body.style.userSelect = ""; }
  });
  tick();
};
// 기능 토글: cc_feat_vod_timeline (기본 ON)
chrome.storage.local.get('cc_feat_vod_timeline').then((o) => {
  if (o.cc_feat_vod_timeline !== false) __cvtMain();
}).catch(() => __cvtMain());
