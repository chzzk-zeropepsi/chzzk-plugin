// 격리(ISOLATED) world: chrome.storage 설정 + 기능 토글(cc_feat_preview)을
// MAIN world의 미리보기(preview_main.js)로 전달. (chzzk-plugin 통합)
const CZP_DEFAULTS = {
  enabled: true,
  livePreview: true,
  width: 400,
  delay: 1,
  volume: 5,
};

function czpSend(config, featOn) {
  // 마스터 토글(cc_feat_preview)이 꺼져 있으면 enabled=false로 강제
  const merged = { ...CZP_DEFAULTS, ...config, enabled: featOn && config.enabled !== false };
  window.postMessage({ type: "czp-config", config: merged }, location.origin);
}

function czpPush() {
  chrome.storage.local.get({ czpConfig: CZP_DEFAULTS, cc_feat_preview: true }, (r) => {
    czpSend(r.czpConfig || CZP_DEFAULTS, r.cc_feat_preview !== false);
  });
}

czpPush();

window.addEventListener("message", (e) => {
  if (e.source === window && e.data && e.data.type === "czp-getconfig") czpPush();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.czpConfig || changes.cc_feat_preview)) czpPush();
});
