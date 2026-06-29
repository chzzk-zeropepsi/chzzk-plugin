// 치지직 채팅 도구 - content script
//   1) 채팅 폰트 크기 (zoom: 글자+닉네임+이모티콘 같은 비율)
//   2) 이모티콘 hover 큰 미리보기 (크기 조절 가능)
const __chatFontMain = function () {
  "use strict";

  var DEF = 14, MIN = 10, MAX = 30;
  function clamp(n) { return Math.max(MIN, Math.min(MAX, n)); }
  function clampE(n) { return Math.max(80, Math.min(300, n)); }

  var size = DEF;
  var emoteHover = true;
  var emoteSize = 130;

  // ── 1) 폰트 (zoom) ──
  var style = document.createElement("style");
  style.id = "cz-chatfont-style";
  (document.head || document.documentElement).appendChild(style);
  function applyFont() {
    var z = (size / 14).toFixed(3);
    style.textContent = '[class*="chatting_message"]{zoom:' + z + ";}";
  }
  applyFont();

  // ── 2) 이모티콘 hover 미리보기 ──
  var preview = null, pImg = null, pCap = null;
  function ensurePreview() {
    if (preview) return;
    preview = document.createElement("div");
    preview.id = "cz-emote-preview";
    preview.style.cssText =
      "position:fixed;z-index:2147483647;pointer-events:none;display:none;" +
      "flex-direction:column;align-items:center;gap:5px;padding:8px;" +
      "background:rgba(22,22,24,0.96);border-radius:12px;box-shadow:0 6px 20px rgba(0,0,0,0.5);";
    pImg = document.createElement("img");
    pImg.style.cssText = "object-fit:contain;display:block;";
    pCap = document.createElement("div");
    pCap.style.cssText =
      "color:#e8e8e8;font:12px/1.3 -apple-system,'Malgun Gothic',sans-serif;max-width:220px;text-align:center;word-break:break-all;";
    preview.appendChild(pImg);
    preview.appendChild(pCap);
    document.body.appendChild(preview);
  }
  // 진짜 이모티콘만: alt="{:코드:}" 또는 채팅 메시지 내부 이미지
  function isEmote(el) {
    if (!el || el.tagName !== "IMG") return false;
    var alt = el.getAttribute("alt") || "";
    if (/^\{:.+:\}$/.test(alt)) return true;
    if (el.closest && el.closest('[class*="chatting_message"]')) return true;
    return false;
  }
  function emoteName(el) {
    var alt = el.getAttribute("alt") || "";
    var m = alt.match(/^\{:(.+):\}$/);
    if (m) return m[1];
    var btn = el.closest && el.closest("button");
    var blind = btn && btn.querySelector(".blind");
    return blind ? blind.textContent.trim() : "";
  }
  function showPreview(el) {
    ensurePreview();
    // type=f60_60 등 파라미터가 있으면 f120으로만 올림(더 크게 요청하면 일부 이모티콘이 깨짐)
    var src = (el.currentSrc || el.src || "").replace(/type=f\d+_\d+/, "type=f120_120");
    pImg.src = src;
    pImg.style.width = emoteSize + "px";
    pImg.style.height = emoteSize + "px";
    pCap.textContent = emoteName(el);
    preview.style.display = "flex";
    var r = el.getBoundingClientRect();
    var pw = preview.offsetWidth || emoteSize + 16, ph = preview.offsetHeight || emoteSize + 30;
    var left = r.left + r.width / 2 - pw / 2;
    var top = r.top - ph - 8;
    if (top < 4) top = r.bottom + 8;
    left = Math.max(4, Math.min(left, window.innerWidth - pw - 4));
    preview.style.left = Math.round(left) + "px";
    preview.style.top = Math.round(top) + "px";
  }
  function hidePreview() { if (preview) preview.style.display = "none"; }

  document.addEventListener("mouseover", function (e) {
    if (!emoteHover) return;
    if (isEmote(e.target)) showPreview(e.target);
  }, true);
  document.addEventListener("mouseout", function (e) {
    if (isEmote(e.target)) hidePreview();
  }, true);

  // ── 설정 로드 / 동기화 ──
  function applyAll() { applyFont(); if (!emoteHover) hidePreview(); }
  try {
    chrome.storage.local.get(["chatFont", "emoteHover", "emoteSize"], function (r) {
      if (typeof r.chatFont === "number") size = clamp(r.chatFont);
      if (typeof r.emoteHover === "boolean") emoteHover = r.emoteHover;
      if (typeof r.emoteSize === "number") emoteSize = clampE(r.emoteSize);
      applyAll();
    });
  } catch (e) {}
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local") return;
    if (changes.chatFont && typeof changes.chatFont.newValue === "number") size = clamp(changes.chatFont.newValue);
    if (changes.emoteHover && typeof changes.emoteHover.newValue === "boolean") emoteHover = changes.emoteHover.newValue;
    if (changes.emoteSize && typeof changes.emoteSize.newValue === "number") emoteSize = clampE(changes.emoteSize.newValue);
    applyAll();
  });

  function setSize(n) { size = clamp(n); applyFont(); try { chrome.storage.local.set({ chatFont: size }); } catch (e) {} }

  // ── 단축키 (폰트) ──
  window.addEventListener(
    "keydown",
    function (e) {
      var t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.code === "BracketRight") { e.preventDefault(); setSize(size + 1); }
      else if (e.code === "BracketLeft") { e.preventDefault(); setSize(size - 1); }
      else if (e.code === "Backslash") { e.preventDefault(); setSize(DEF); }
    },
    true
  );
};
// 기능 토글: cc_feat_chat_font (기본 ON)
chrome.storage.local.get('cc_feat_chat_font').then((o) => {
  if (o.cc_feat_chat_font !== false) __chatFontMain();
}).catch(() => __chatFontMain());
