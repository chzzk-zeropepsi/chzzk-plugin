// Firebase RTDB 기반 설정 동기화
import { FIREBASE_CONFIG } from './firebase_config.js';

export const SYNC_ENABLED_KEY = 'cc_sync_enabled';
export const SYNC_AUTH_KEY = 'cc_sync_auth';
export const SYNC_META_KEY = 'cc_sync_meta';
export const SYNC_USER_KEY = 'cc_sync_user_id';
export const SYNC_STATUS_KEY = 'cc_sync_status';

const DENY = new Set([
  SYNC_ENABLED_KEY, SYNC_AUTH_KEY, SYNC_META_KEY, SYNC_USER_KEY, SYNC_STATUS_KEY,
  'notify_states',
]);

function configured() {
  return FIREBASE_CONFIG?.apiKey
    && !FIREBASE_CONFIG.apiKey.startsWith('YOUR_')
    && FIREBASE_CONFIG.projectId
    && !FIREBASE_CONFIG.projectId.startsWith('YOUR_');
}

async function setStatus(msg, kind = 'info') {
  await chrome.storage.local.set({ [SYNC_STATUS_KEY]: { msg, kind, ts: Date.now() } });
}

async function fetchChzzkUserId() {
  const tabs = await chrome.tabs.query({ url: 'https://chzzk.naver.com/*' });
  if (!tabs.length) throw new Error('치지직 탭을 열어주세요');
  const res = await chrome.tabs.sendMessage(tabs[0].id, {
    type: 'cc-fetch-json-proxy',
    url: 'https://comm-api.game.naver.com/nng_main/v1/user/getUserStatus',
  });
  if (!res?.ok) throw new Error('chzzk user status: ' + (res?.error || 'unknown'));
  const j = res.data;
  if (!j?.content?.loggedIn) throw new Error('치지직 로그인 필요');
  return j.content.userIdHash;
}

async function getUserId() {
  const { [SYNC_USER_KEY]: uid } = await chrome.storage.local.get(SYNC_USER_KEY);
  if (uid) return uid;
  const fresh = await fetchChzzkUserId();
  await chrome.storage.local.set({ [SYNC_USER_KEY]: fresh });
  return fresh;
}

async function authAnonymous() {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_CONFIG.apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnSecureToken: true }),
  });
  if (!r.ok) throw new Error('firebase auth ' + r.status);
  const j = await r.json();
  return saveAuth({
    idToken: j.idToken,
    refreshToken: j.refreshToken,
    localId: j.localId,
    expiresAt: Date.now() + parseInt(j.expiresIn, 10) * 1000 - 60_000,
  });
}

async function refreshAuth(refreshToken) {
  const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${FIREBASE_CONFIG.apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
  });
  if (!r.ok) throw new Error('firebase refresh ' + r.status);
  const j = await r.json();
  return saveAuth({
    idToken: j.id_token,
    refreshToken: j.refresh_token,
    localId: j.user_id,
    expiresAt: Date.now() + parseInt(j.expires_in, 10) * 1000 - 60_000,
  });
}

async function saveAuth(auth) {
  await chrome.storage.local.set({ [SYNC_AUTH_KEY]: auth });
  return auth;
}

async function getAuth() {
  const { [SYNC_AUTH_KEY]: auth } = await chrome.storage.local.get(SYNC_AUTH_KEY);
  if (auth && auth.expiresAt > Date.now()) return auth;
  if (auth?.refreshToken) {
    try { return await refreshAuth(auth.refreshToken); } catch (_) {}
  }
  return await authAnonymous();
}

function docUrl(userId) {
  return `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/userSettings/${encodeURIComponent(userId)}`;
}

async function pullRemote() {
  const auth = await getAuth();
  const uid = await getUserId();
  const r = await fetch(docUrl(uid), { headers: { Authorization: 'Bearer ' + auth.idToken } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('firestore pull ' + r.status);
  const j = await r.json();
  const f = j?.fields || {};
  const dataStr = f.data?.stringValue ?? '{}';
  const updatedAt = parseInt(f.updatedAt?.integerValue ?? f.updatedAt?.stringValue ?? '0', 10);
  return { data: JSON.parse(dataStr), updatedAt };
}

async function pushRemote(data) {
  const auth = await getAuth();
  const uid = await getUserId();
  const updatedAt = Date.now();
  const body = {
    fields: {
      data: { stringValue: JSON.stringify(data) },
      updatedAt: { integerValue: String(updatedAt) },
    },
  };
  const r = await fetch(docUrl(uid), {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + auth.idToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('firestore push ' + r.status);
  await chrome.storage.local.set({ [SYNC_META_KEY]: { updatedAt, lastPushedAt: updatedAt } });
  return updatedAt;
}

function collectSyncable(all) {
  const out = {};
  for (const [k, v] of Object.entries(all)) if (!DENY.has(k)) out[k] = v;
  return out;
}

export async function syncOnce() {
  if (!configured()) { await setStatus('Firebase 설정 필요', 'warn'); return { skipped: 'no-config' }; }
  try {
    const remote = await pullRemote();
    const all = await chrome.storage.local.get(null);
    const { [SYNC_META_KEY]: meta } = await chrome.storage.local.get(SYNC_META_KEY);
    const localUpdatedAt = meta?.updatedAt || 0;
    const remoteUpdatedAt = remote?.updatedAt || 0;

    if (!remote) {
      const ts = await pushRemote(collectSyncable(all));
      await setStatus('첫 업로드 완료', 'ok');
      return { action: 'push-initial', ts };
    }
    if (remoteUpdatedAt > localUpdatedAt) {
      const remoteData = remote.data || {};
      const toRemove = Object.keys(all).filter((k) => !DENY.has(k) && !(k in remoteData));
      if (toRemove.length) await chrome.storage.local.remove(toRemove);
      await chrome.storage.local.set({ ...remoteData, [SYNC_META_KEY]: { updatedAt: remoteUpdatedAt, lastPulledAt: Date.now() } });
      await setStatus(`서버 → 로컬 적용 (${new Date(remoteUpdatedAt).toLocaleString()})`, 'ok');
      return { action: 'pull', remoteUpdatedAt };
    }
    if (localUpdatedAt > remoteUpdatedAt) {
      const ts = await pushRemote(collectSyncable(all));
      await setStatus(`로컬 → 서버 업로드 완료`, 'ok');
      return { action: 'push', ts };
    }
    await setStatus('이미 최신', 'info');
    return { action: 'noop' };
  } catch (e) {
    await setStatus('동기화 실패: ' + e.message, 'err');
    throw e;
  }
}

let pushTimer = null;
export function listenAndPush() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const keys = Object.keys(changes);
    if (keys.every((k) => DENY.has(k))) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(async () => {
      if (!configured()) return;
      try {
        const all = await chrome.storage.local.get(null);
        await pushRemote(collectSyncable(all));
        await setStatus(`자동 동기화 완료`, 'ok');
      } catch (e) {
        await setStatus('자동 동기화 실패: ' + e.message, 'err');
      }
    }, 2500);
  });
}

export async function enableSync() {
  await chrome.storage.local.set({ [SYNC_ENABLED_KEY]: true });
  return await syncOnce();
}

export async function disableSync() {
  await chrome.storage.local.set({ [SYNC_ENABLED_KEY]: false });
  await chrome.storage.local.remove([SYNC_AUTH_KEY, SYNC_USER_KEY]);
  await setStatus('동기화 OFF', 'info');
}
