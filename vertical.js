// CHZZK 플러그인 - 라이브 페이지 세로 레이아웃 토글
(function () {
  const LIVE_RE = /\/live\/[^/?#]+/;
  const VERT_KEY = 'cc_vertical_mode';
  const HEIGHT_KEY = 'cc_chat_height_vh';
  const MIN_VH = 5;
  const MAX_VH = 95;
  let verticalMode = false;
  let chatHeightVh = 40;

  chrome.storage.local.get([VERT_KEY, HEIGHT_KEY]).then((o) => {
    verticalMode = o[VERT_KEY] === true;
    if (typeof o[HEIGHT_KEY] === 'number') chatHeightVh = clamp(o[HEIGHT_KEY]);
    applyHeight();
    applyMode();
  });
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== 'local') return;
    if (c[VERT_KEY]) {
      verticalMode = c[VERT_KEY].newValue === true;
      applyMode();
      syncBtn();
    }
    if (c[HEIGHT_KEY] && typeof c[HEIGHT_KEY].newValue === 'number') {
      chatHeightVh = clamp(c[HEIGHT_KEY].newValue);
      applyHeight();
    }
  });

  function clamp(v) {
    return Math.max(MIN_VH, Math.min(MAX_VH, v));
  }

  function applyHeight() {
    const v = chatHeightVh + 'vh';
    document.documentElement.style.setProperty('--cc-chat-height', v);
    const aside = document.getElementById('aside-chatting');
    if (aside) {
      aside.style.setProperty('height', v, 'important');
      aside.style.setProperty('max-height', v, 'important');
      aside.style.setProperty('min-height', v, 'important');
      aside.style.setProperty('flex', '0 0 auto', 'important');
    }
  }

  function applyMode() {
    const active = verticalMode && LIVE_RE.test(location.pathname);
    document.documentElement.classList.toggle('cc-vertical-layout', active);
    ensureHandle();
    syncSidebar(active);
  }

  let sidebarWasExpanded = null;
  function syncSidebar(active) {
    const btn = document.querySelector('button[aria-controls="navigation"]');
    if (!btn) return;
    const expanded = btn.getAttribute('aria-expanded') === 'true';
    if (active) {
      if (sidebarWasExpanded === null) sidebarWasExpanded = expanded;
      if (expanded) btn.click();
    } else if (sidebarWasExpanded === true && !expanded) {
      btn.click();
      sidebarWasExpanded = null;
    } else if (sidebarWasExpanded !== null) {
      sidebarWasExpanded = null;
    }
  }

  function ensureHandle() {
    if (!document.documentElement.classList.contains('cc-vertical-layout')) {
      document.querySelectorAll('.cc-split-handle').forEach((el) => el.remove());
      return;
    }
    let handle = document.body.querySelector(':scope > .cc-split-handle');
    if (!handle) {
      handle = document.createElement('div');
      handle.className = 'cc-split-handle';
      handle.title = '드래그해서 영상/채팅 비율 조정';
      attachDrag(handle);
      document.body.appendChild(handle);
    }
  }

  function attachDrag(handle) {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startVh = chatHeightVh;
      const vhPx = window.innerHeight / 100;
      handle.classList.add('cc-dragging');
      document.documentElement.classList.add('cc-resizing');

      function onMove(ev) {
        const deltaVh = (startY - ev.clientY) / vhPx;
        chatHeightVh = clamp(startVh + deltaVh);
        applyHeight();
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        handle.classList.remove('cc-dragging');
        document.documentElement.classList.remove('cc-resizing');
        chrome.storage.local.set({ [HEIGHT_KEY]: chatHeightVh });
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  function syncBtn() {
    const btn = document.getElementById('cc-vert-btn');
    if (btn) {
      btn.classList.toggle('cc-on', verticalMode);
      btn.title = verticalMode ? '세로 레이아웃 끄기' : '세로 레이아웃 켜기 (영상↑/채팅↓)';
    }
  }

  function injectButton() {
    if (!LIVE_RE.test(location.pathname)) return;
    const bar = document.querySelector('.pzp-pc__bottom-buttons-right') || document.querySelector('.pzp-pc__bottom-buttons');
    if (!bar) return;
    if (bar.querySelector('#cc-vert-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'cc-vert-btn';
    btn.type = 'button';
    btn.className = 'pzp-pc__btn pzp-button cc-vert-btn';
    const wideBtn = document.querySelector('.pzp-pc__wide-screen-button, .pzp-pc__btn-wide, [aria-label*="넓은"], [aria-label*="wide" i]');
    if (wideBtn) {
      btn.innerHTML = wideBtn.innerHTML.replace(/넓은 화면/g, '긴 화면');
    } else {
      btn.innerHTML = '<span style="font-size:14px;line-height:1;">⫼</span>';
    }
    btn.title = '세로 레이아웃 토글';
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      verticalMode = !verticalMode;
      chrome.storage.local.set({ [VERT_KEY]: verticalMode });
      applyMode();
      syncBtn();
    });
    const viewmodeBtn = bar.querySelector('.pzp-viewmode-button, .pzp-pc__viewmode-button');
    if (viewmodeBtn) bar.insertBefore(btn, viewmodeBtn);
    else bar.appendChild(btn);
    syncBtn();
  }

  const obs = new MutationObserver(() => {
    injectButton();
    ensureHandle();
  });
  obs.observe(document.body, { childList: true, subtree: true });
  injectButton();

  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    applyMode();
    document.getElementById('cc-vert-btn')?.remove();
    injectButton();
  }, 1500);
})();
