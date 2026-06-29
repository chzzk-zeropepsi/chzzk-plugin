(() => {
  "use strict";

  // ===================================================================
  // 치지직 팔로잉 미리보기 (독립 확장) - MAIN world
  // 사이드바 팔로잉 채널 hover → 썸네일 + hls.js 실시간 영상 미리보기
  // 디버그: localStorage.setItem("czpDebug","1") 후 새로고침
  // ===================================================================
  const DEBUG = (() => {
    try {
      return localStorage.getItem("czpDebug") === "1";
    } catch {
      return false;
    }
  })();
  const log = (...a) => {
    if (DEBUG) console.log("%c[czp]", "color:#00ffa3;font-weight:bold", ...a);
  };

  // ---- 설정 (브리지에서 갱신) ----
  let cfg = {
    enabled: true,
    livePreview: true,
    width: 400,
    delay: 1,
    volume: 5,
  };
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.type === "czp-config") {
      cfg = { ...cfg, ...e.data.config };
      log("config", cfg);
    }
  });
  window.postMessage({ type: "czp-getconfig" }, location.origin);

  // ---- 유틸 ----
  const numberFormat = new Intl.NumberFormat("ko-KR");
  const padNumber = (n, len) => n.toString().padStart(len, "0");
  const formatUptime = (ms) => {
    let s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor(s / 60) % 60;
    s = s % 60;
    return h
      ? `${h}:${padNumber(m, 2)}:${padNumber(s, 2)}`
      : `${m}:${padNumber(s, 2)}`;
  };

  const parseLiveUid = (href) => {
    try {
      const p = new URL(href, location.origin).pathname.split("/");
      return p[1] === "live" && p[2] ? p[2] : null;
    } catch {
      return null;
    }
  };

  const waitFor = (selector, timeout = 15000) =>
    new Promise((resolve) => {
      const found = document.querySelector(selector);
      if (found) return resolve(found);
      let timer;
      const obs = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          obs.disconnect();
          clearTimeout(timer);
          resolve(el);
        }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      timer = setTimeout(() => {
        obs.disconnect();
        resolve(null);
      }, timeout);
    });

  // ---- live-detail API ----
  const liveInfoCache = {};
  const fetchLiveInfo = async (uid) => {
    if (uid in liveInfoCache) return liveInfoCache[uid];
    let info = null;
    for (const ver of ["v3.2", "v3", "v2"]) {
      try {
        const res = await fetch(
          `https://api.chzzk.naver.com/service/${ver}/channels/${uid}/live-detail`,
          { credentials: "include" }
        );
        if (!res.ok) continue;
        const json = await res.json();
        if (json.code !== 200 || !json.content) continue;
        info = json.content;
        try {
          info.livePlayback = JSON.parse(info.livePlaybackJson);
        } catch {}
        break;
      } catch {}
    }
    liveInfoCache[uid] = info;
    return info;
  };

  const getHlsUrl = (info) => {
    const media = info?.livePlayback?.media;
    if (!Array.isArray(media)) return null;
    const m =
      media.find((x) => x.mediaId === "LLHLS") ||
      media.find((x) => x.mediaId === "HLS") ||
      media[0];
    return m?.path || null;
  };

  // ---- 미리보기 ----
  const Preview = {
    el: null,
    thumb: null,
    video: null,
    uptimeEl: null,
    progressEl: null,
    hls: null,
    uid: null,
    timer: null,
    raf: null,
    uptimeTimer: null,

    ensure() {
      if (this.el) return;
      const mk = (cls, tag = "div") => {
        const e = document.createElement(tag);
        e.className = cls;
        return e;
      };
      const el = mk("czp-preview");
      this.thumb = mk("czp-thumb", "img");
      this.video = mk("czp-video", "video");
      this.video.playsInline = true;
      this.progressEl = mk("czp-progress");

      const top = mk("czp-top");
      const live = mk("czp-live");
      live.textContent = "LIVE";
      this.uptimeEl = mk("czp-uptime");
      this.viewersEl = mk("czp-viewers");
      top.append(live, this.uptimeEl, this.viewersEl);

      const info = mk("czp-info");
      this.titleEl = mk("czp-title");
      const meta = mk("czp-meta");
      this.channelEl = mk("czp-channel");
      this.categoryEl = mk("czp-category");
      meta.append(this.channelEl, this.categoryEl);
      info.append(this.titleEl, meta);

      el.append(this.thumb, this.video, this.progressEl, top, info);
      document.body.appendChild(el);
      this.el = el;
    },

    async show(href, node) {
      if (!cfg.enabled) return;
      const uid = parseLiveUid(href);
      if (!uid) return;
      const info = await fetchLiveInfo(uid);
      if (!info) return;
      this.hide();
      this.uid = uid;
      this.ensure();

      const rect = node.getBoundingClientRect();
      if (!rect.width) return;
      const width = Math.max(cfg.width || 400, 200);
      const height = (width * 9) / 16;
      let left = rect.right + 8;
      if (left + width > window.innerWidth - 8) left = rect.left - width - 8;
      left = Math.max(8, left);
      let top = rect.top + rect.height / 2 - height / 2;
      top = Math.max(8, Math.min(top, window.innerHeight - height - 8));
      this.el.style.width = `${width}px`;
      this.el.style.left = `${Math.round(left)}px`;
      this.el.style.top = `${Math.round(top)}px`;

      // 썸네일
      this.thumb.src = (
        info.liveImageUrl ||
        info.livePlayback?.thumbnail?.snapshotThumbnailTemplate ||
        ""
      ).replace("{type}", "480");

      // 정보 (API 우선, 사이드바 아이템으로 보강)
      const item = node.closest('[class*="_item_"]') || node.parentElement;
      const channelName =
        info.channel?.channelName ||
        item?.querySelector('[class*="_name_"]')?.textContent?.trim() ||
        "";
      const viewers = info.concurrentUserCount;
      const viewersText =
        viewers != null
          ? numberFormat.format(viewers)
          : item?.querySelector('[class*="_count_"]')?.textContent?.trim() || "";
      const category = info.liveCategoryValue || info.liveCategory || "";

      this.titleEl.textContent = info.liveTitle || "";
      this.channelEl.textContent = channelName;
      this.categoryEl.textContent = category;
      this.categoryEl.style.display = category ? "" : "none";
      this.viewersEl.textContent = viewersText ? `\u{1F441} ${viewersText}` : "";
      this.viewersEl.style.display = viewersText ? "" : "none";

      this.uptimeEl.textContent = "";
      this.progressEl.style.display = "none";
      this.video.classList.remove("czp-video-on");

      // 등장 애니메이션
      requestAnimationFrame(() => this.el && this.el.classList.add("czp-in"));

      const openDate = info.openDate
        ? new Date(`${info.openDate}+0900`).getTime()
        : 0;
      const tick = () => {
        if (openDate) this.uptimeEl.textContent = formatUptime(Date.now() - openDate);
      };
      tick();
      this.uptimeTimer = setInterval(tick, 1000);

      if (!cfg.livePreview || !window.Hls || !window.Hls.isSupported()) return;
      const hlsUrl = getHlsUrl(info);
      if (!hlsUrl) return;
      const delayMs = Math.max(0, (cfg.delay ?? 1) * 1000);

      this.progressEl.style.display = "";
      this.progressEl.style.width = "0%";
      const start = performance.now();
      const step = (now) => {
        if (this.uid !== uid) return;
        const p = Math.min(100, ((now - start) / Math.max(1, delayMs)) * 100);
        this.progressEl.style.width = `${p}%`;
        if (p < 100) this.raf = requestAnimationFrame(step);
      };
      if (delayMs > 0) this.raf = requestAnimationFrame(step);

      this.timer = setTimeout(() => {
        if (this.uid !== uid) return;
        this.progressEl.style.display = "none";
        try {
          this.hls = new window.Hls({
            maxBufferLength: 6,
            backBufferLength: 0,
            capLevelToPlayerSize: true,
            lowLatencyMode: true,
          });
          this.hls.loadSource(hlsUrl);
          this.hls.attachMedia(this.video);
        } catch (e) {
          log("hls error", e);
          return;
        }
        this.video.volume = Math.min(1, (cfg.volume ?? 5) / 100);
        this.video.onplaying = () => {
          if (this.uid === uid) this.video.classList.add("czp-video-on");
        };
        const playP = this.video.play();
        if (playP?.catch) {
          playP.catch(() => {
            this.video.muted = true;
            this.video.play().catch(() => {});
          });
        }
      }, delayMs);
    },

    hide(href) {
      if (href != null) {
        const uid = parseLiveUid(href);
        if (uid && this.uid !== uid) return;
      }
      this.uid = null;
      clearTimeout(this.timer);
      clearInterval(this.uptimeTimer);
      cancelAnimationFrame(this.raf);
      if (this.hls) {
        try {
          this.hls.destroy();
        } catch {}
        this.hls = null;
      }
      if (this.video) {
        this.video.onplaying = null;
        this.video.classList.remove("czp-video-on");
        this.video.muted = false;
        this.video.removeAttribute("src");
        try {
          this.video.load();
        } catch {}
      }
      if (this.el) this.el.classList.remove("czp-in");
    },
  };

  // ---- 사이드바 채널 hover 부착 ----
  const attachSidebar = (sidebar) => {
    if (sidebar.__czp) return;
    sidebar.__czp = true;

    const addLink = (a) => {
      if (a.__czp || !parseLiveUid(a.href)) return;
      a.__czp = true;
      a.addEventListener("mouseenter", () => Preview.show(a.href, a));
      a.addEventListener("mouseleave", () => Preview.hide(a.href));
    };

    sidebar.querySelectorAll('a[href^="/live/"]').forEach(addLink);
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.matches?.('a[href^="/live/"]')) addLink(n);
          n.querySelectorAll?.('a[href^="/live/"]').forEach(addLink);
        }
      }
    });
    obs.observe(sidebar, { childList: true, subtree: true });
    log("sidebar attached");
  };

  window.addEventListener(
    "scroll",
    () => {
      if (Preview.uid) Preview.hide();
    },
    { capture: true, passive: true }
  );
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") Preview.hide();
  });

  waitFor("#sidebar").then((s) => s && attachSidebar(s));
})();
