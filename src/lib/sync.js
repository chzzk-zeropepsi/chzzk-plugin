// Firebase RTDB 기반 설정 동기화
import { FIREBASE_CONFIG } from './firebase_config.js';

export const SYNC_ENABLED_KEY = 'cc_sync_enabled';
export const SYNC_AUTH_KEY = 'cc_sync_auth';
export const SYNC_META_KEY = 'cc_sync_meta';
export const SYNC_USER_KEY = 'cc_sync_user_id';
export const SYNC_STATUS_KEY = 'cc_sync_status';
export const LATEST_VERSION_KEY = 'cc_latest_version'; // { version, checkedAt }

const DENY = new Set([
  SYNC_ENABLED_KEY, SYNC_AUTH_KEY, SYNC_META_KEY, SYNC_USER_KEY, SYNC_STATUS_KEY, LATEST_VERSION_KEY,
  'notify_states',
  'cc_active_recordings', // 탭별 ephemeral 상태
]);

function currentVersion() {
  try { return chrome.runtime.getManifest().version; } catch (_) { return null; }
}

// 0.2.10 > 0.2.9 식으로 의미 있게 비교
function cmpVersion(a, b) {
  const pa = String(a || '').split('.').map(Number);
  const pb = String(b || '').split('.').map(Number);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

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
function latestVersionDocUrl() {
  return `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/plugin-version/version`;
}

// plugin-version/version 문서에서 최신 버전 조회 → 로컬 캐시. 업데이트 권유 표시용.
export async function checkLatestVersion() {
  if (!configured()) { console.warn('[cc-sync] checkLatestVersion: firebase 미설정'); return null; }
  try {
    const auth = await getAuth();
    const r = await fetch(latestVersionDocUrl(), { headers: { Authorization: 'Bearer ' + auth.idToken } });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.warn('[cc-sync] checkLatestVersion 실패:', r.status, txt.slice(0, 200));
      return null;
    }
    const j = await r.json();
    // 필드 타입에 따라 적절히 읽기
    const f = j?.fields?.version;
    const v = f?.stringValue ?? f?.integerValue ?? f?.doubleValue;
    if (v == null) {
      console.warn('[cc-sync] checkLatestVersion: version 필드 없음', j);
      return null;
    }
    const cur = currentVersion();
    const info = { version: String(v), current: cur, updateAvailable: cmpVersion(cur, String(v)) < 0, checkedAt: Date.now() };
    console.log('[cc-sync] 버전 확인:', info);
    await chrome.storage.local.set({ [LATEST_VERSION_KEY]: info });
    return info;
  } catch (e) {
    console.warn('[cc-sync] checkLatestVersion 예외:', e);
    return null;
  }
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
      version: { stringValue: currentVersion() || '' },
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
      const rawRemote = remote.data || {};
      // DENY 키는 원격에서 가져오지 않음 (이전 버그로 인한 stale data 차단)
      const remoteData = {};
      for (const [k, v] of Object.entries(rawRemote)) if (!DENY.has(k)) remoteData[k] = v;
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
  } finally {
    checkLatestVersion().catch(() => {});
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
        checkLatestVersion().catch(() => {});
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
