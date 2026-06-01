// CHZZK Companion - chat WebSocket hook (MAIN world)
// 채널 진입 시 자동으로 chat 메시지 템플릿을 구축해서 임의 메시지 전송 가능.
(function () {
  if (window.__ccChatHooked) return;
  window.__ccChatHooked = true;

  const CHAT_HOST_RE = /chat\.naver\.com/;
  const SEND_CHAT_CMD = 3101;
  const CONNECT_CMD = 100;
  const CONNECT_RES_CMD = 10100;

  const sockets = new Set();
  let chatCid = null;     // chatChannelId (예: N2Weih)
  let chatSid = null;     // server-assigned sid
  let chatUid = null;
  let extraToken = null;
  let lastChatTemplate = null; // 우선순위 1: 사용자가 직접 보낸 템플릿 (가장 정확)
  let autoTemplate = null;     // 우선순위 2: 자동 구축 템플릿
  let tidCounter = 100;

  function notify(data) { try { window.postMessage(data, '*'); } catch (_) {} }

  function streamingChannelIdFromUrl() {
    const m = location.pathname.match(/\/live\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  async function fetchExtraToken(chatChannelId) {
    try {
      const r = await fetch(`https://comm-api.game.naver.com/nng_main/v1/chats/access-token?channelId=${encodeURIComponent(chatChannelId)}&chatType=STREAMING`, { credentials: 'include' });
      if (!r.ok) return null;
      const j = await r.json();
      return j?.content?.extraToken || null;
    } catch (_) { return null; }
  }

  async function buildAutoTemplate() {
    if (autoTemplate) return autoTemplate;
    if (!chatCid || !chatSid) return null;
    const streamingChannelId = streamingChannelIdFromUrl();
    if (!streamingChannelId) return null;
    if (!extraToken) extraToken = await fetchExtraToken(chatCid);
    if (!extraToken) return null;
    autoTemplate = {
      ver: '3',
      cmd: SEND_CHAT_CMD,
      svcid: 'game',
      cid: chatCid,
      sid: chatSid,
      bdy: {
        msg: '',
        msgTypeCode: 1,
        extras: JSON.stringify({
          chatType: 'STREAMING',
          osType: 'PC',
          extraToken,
          streamingChannelId,
          emojis: {},
        }),
        msgTime: 0,
      },
      tid: 0,
    };
    return autoTemplate;
  }

  // 들어오는 채팅 추적 (세로 보내기 동기화용)
  const incomingListeners = new Set(); // cb(item) — item = { uid, msg, msgTime }
  let lastIncomingTs = 0;

  function attachIncomingListener(ws) {
    if (ws.__ccMsgHooked) return;
    ws.__ccMsgHooked = true;
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') return;
      try {
        const obj = JSON.parse(ev.data);
        if (obj?.cmd === CONNECT_RES_CMD && obj?.bdy?.sid) {
          chatSid = obj.bdy.sid;
          buildAutoTemplate();
          return;
        }
        // 새 채팅 메시지 (cmd 93101: bdy가 array)
        if (Array.isArray(obj?.bdy)) {
          for (const item of obj.bdy) {
            if (typeof item?.msg === 'string' && item?.uid) {
              lastIncomingTs = Date.now();
              for (const cb of incomingListeners) {
                try { cb(item); } catch (_) {}
              }
            }
          }
        }
      } catch (_) {}
    });
  }

  function resetChannelState(reason) {
    console.log('[cc-chat] reset channel state:', reason);
    chatCid = null;
    chatSid = null;
    extraToken = null;
    lastChatTemplate = null;
    autoTemplate = null;
  }

  // URL이 다른 라이브 채널로 바뀌면 미리 상태 리셋 (chzzk가 WS 재연결할 때까지 send 안 되게)
  let lastPathLiveCid = streamingChannelIdFromUrl();
  function checkUrlChange() {
    const cur = streamingChannelIdFromUrl();
    if (cur !== lastPathLiveCid) {
      resetChannelState(`URL 변경 ${lastPathLiveCid} → ${cur}`);
      lastPathLiveCid = cur;
    }
  }
  const _push = history.pushState;
  history.pushState = function () { const r = _push.apply(this, arguments); checkUrlChange(); return r; };
  const _replace = history.replaceState;
  history.replaceState = function () { const r = _replace.apply(this, arguments); checkUrlChange(); return r; };
  window.addEventListener('popstate', checkUrlChange);

  const _send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    try {
      if (this.url && CHAT_HOST_RE.test(this.url)) {
        sockets.add(this);
        attachIncomingListener(this);
        if (typeof data === 'string') {
          try {
            const obj = JSON.parse(data);
            if (obj?.cmd === CONNECT_CMD) {
              const newCid = obj.cid;
              if (newCid && chatCid && newCid !== chatCid) {
                resetChannelState(`cid 변경 ${chatCid} → ${newCid}`);
              }
              chatCid = newCid || chatCid;
              chatUid = obj?.bdy?.uid || chatUid;
            } else if (obj?.bdy && typeof obj.bdy.msg === 'string' && obj.bdy.msg.length > 0) {
              // 다른 cid로 보내는 메시지면 우리가 캡처한 cid와 다를 수 있음 — 일관성 체크
              if (obj.cid && chatCid && obj.cid !== chatCid) {
                resetChannelState(`send cid 변경 ${chatCid} → ${obj.cid}`);
                chatCid = obj.cid;
              }
              lastChatTemplate = obj;
              if (typeof obj.tid === 'number') tidCounter = Math.max(tidCounter, obj.tid + 1);
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
    return _send.apply(this, arguments);
  };

  function aliveChatSocket() {
    // 닫힌 소켓 정리
    for (const ws of sockets) if (ws.readyState >= 2) sockets.delete(ws);
    let last = null;
    for (const ws of sockets) if (ws.readyState === 1) last = ws;
    return last;
  }

  async function getTemplate() {
    if (lastChatTemplate) return lastChatTemplate;
    return await buildAutoTemplate();
  }

  let sendingNow = false;
  async function sendChatMessage(text) {
    if (sendingNow) return { ok: false, error: '이전 전송 진행 중' };
    sendingNow = true;
    try {
      const aliveSockets = [...sockets].filter((w) => w.readyState === 1);
      if (!aliveSockets.length) return { ok: false, error: '연결된 chat WebSocket이 없습니다' };
      // 디버그: chat WS 개수 확인 (중복 연결 진단)
      if (aliveSockets.length > 1) console.warn('[cc-chat] alive chat WS 다수:', aliveSockets.map((w) => w.url));
      const ws = aliveSockets[aliveSockets.length - 1]; // 가장 마지막에 연결된 것 사용
      const tpl = await getTemplate();
      if (!tpl) return { ok: false, error: '채팅 템플릿 구성 실패' };
      const msg = JSON.parse(JSON.stringify(tpl));
      msg.bdy = msg.bdy || {};
      msg.bdy.msg = text;
      msg.bdy.msgTime = Date.now();
      msg.tid = tidCounter++;
      console.log('[cc-chat] sending →', ws.url, msg);
      ws.send(JSON.stringify(msg));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    } finally {
      sendingNow = false;
    }
  }

  // 세로 보내기: 한 글자씩 보내고, 내 메시지 도착 + 채팅 잠시 잠잠 확인 후 다음 글자 전송
  // 다른 사람 채팅이 사이에 끼지 않도록 최대한 노력 (보장은 못 함)
  async function sendVertical(text) {
    const chars = [...String(text)];
    console.log('[cc-chat] vertical start, chars=', chars.length, 'text=', text);
    if (!chars.length) return { ok: false, error: '빈 텍스트' };
    const ws = aliveChatSocket();
    if (!ws) { console.warn('[cc-chat] no alive ws'); return { ok: false, error: '연결된 chat WebSocket 없음' }; }
    console.log('[cc-chat] using ws:', ws.url, 'readyState:', ws.readyState);
    const tpl = await getTemplate();
    if (!tpl) { console.warn('[cc-chat] no template'); return { ok: false, error: '채팅 템플릿 구성 실패' }; }
    console.log('[cc-chat] template cmd:', tpl.cmd, 'sid:', tpl.sid?.slice(0, 20), 'cid:', tpl.cid);
    try {
      for (let i = 0; i < chars.length; i++) {
        const msg = JSON.parse(JSON.stringify(tpl));
        msg.bdy = msg.bdy || {};
        msg.bdy.msg = chars[i];
        msg.bdy.msgTime = Date.now();
        msg.tid = tidCounter++;
        if (ws.readyState !== 1) { console.warn('[cc-chat] ws closed mid-burst at char', i); return { ok: false, error: `'${chars[i]}' 전송 전 WS 닫힘 (readyState=${ws.readyState})` }; }
        ws.send(JSON.stringify(msg));
        console.log('[cc-chat] sent', i + 1, '/', chars.length, '"' + chars[i] + '" tid=', msg.tid);
        if (i < chars.length - 1) await new Promise((r) => setTimeout(r, 10));
      }
    } catch (e) {
      console.error('[cc-chat] vertical error:', e);
      return { ok: false, error: '전송 오류: ' + (e.message || e) };
    }
    return { ok: true, sent: chars };
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d) return;
    if (d.source === 'cc-chat-send-req') {
      sendChatMessage(String(d.text || '')).then((r) => notify({ source: 'cc-chat-send-res', reqId: d.reqId, ...r }));
    } else if (d.source === 'cc-chat-vertical-req') {
      sendVertical(String(d.text || '')).then((r) => notify({ source: 'cc-chat-vertical-res', reqId: d.reqId, ...r }));
    } else if (d.source === 'cc-chat-status-req') {
      const status = {
        hasSocket: !!aliveChatSocket(),
        hasTemplate: !!(lastChatTemplate || autoTemplate),
        cid: chatCid,
        sid: !!chatSid,
        extraToken: !!extraToken,
      };
      notify({ source: 'cc-chat-status-res', reqId: d.reqId, ...status });
    }
  });
})();
