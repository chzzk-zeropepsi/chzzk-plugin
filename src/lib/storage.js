// CHZZK Companion - storage helpers (groups)
// 그룹 스키마: { id, name, color, channelIds: [], order: number, parentId: string|null }
// 저장 위치: chrome.storage.local 키 "groups" → Group[]

const GROUPS_KEY = 'groups';

export async function readGroups() {
  const obj = await chrome.storage.local.get(GROUPS_KEY);
  const list = Array.isArray(obj[GROUPS_KEY]) ? obj[GROUPS_KEY] : [];
  return list.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export async function writeGroups(groups) {
  await chrome.storage.local.set({ [GROUPS_KEY]: groups });
}

export async function upsertGroup(group) {
  const groups = await readGroups();
  const i = groups.findIndex((g) => g.id === group.id);
  if (i >= 0) groups[i] = { ...groups[i], ...group };
  else groups.push({ order: groups.length, channelIds: [], ...group });
  await writeGroups(groups);
  return groups;
}

export async function deleteGroup(id) {
  const all = await readGroups();
  const target = all.find((g) => g.id === id);
  // 자식 그룹은 삭제할 그룹의 부모(없으면 null=루트)로 reparent
  const newParent = target?.parentId ?? null;
  const groups = all
    .filter((g) => g.id !== id)
    .map((g) => g.parentId === id ? { ...g, parentId: newParent } : g);
  await writeGroups(groups);
  return groups;
}

export async function assignChannelToGroup(groupId, channelId) {
  const groups = await readGroups();
  for (const g of groups) g.channelIds = (g.channelIds || []).filter((c) => c !== channelId);
  const target = groups.find((g) => g.id === groupId);
  if (target) target.channelIds.push(channelId);
  await writeGroups(groups);
  return groups;
}

export async function unassignChannel(channelId) {
  const groups = await readGroups();
  for (const g of groups) g.channelIds = (g.channelIds || []).filter((c) => c !== channelId);
  await writeGroups(groups);
  return groups;
}

export function newGroupId() {
  return 'g_' + Math.random().toString(36).slice(2, 10);
}

const NOTIFY_KEY = 'notify_channels';

export async function readNotifyChannels() {
  const obj = await chrome.storage.local.get(NOTIFY_KEY);
  return Array.isArray(obj[NOTIFY_KEY]) ? obj[NOTIFY_KEY] : [];
}

export async function writeNotifyChannels(ids) {
  await chrome.storage.local.set({ [NOTIFY_KEY]: ids });
}

export async function toggleNotifyChannel(channelId) {
  const list = await readNotifyChannels();
  const i = list.indexOf(channelId);
  if (i >= 0) list.splice(i, 1); else list.push(channelId);
  await writeNotifyChannels(list);
  return list;
}

const BM_KEY = 'bookmarks';

export async function readAllBookmarks() {
  const obj = await chrome.storage.local.get(BM_KEY);
  return obj[BM_KEY] || {};
}

export async function writeAllBookmarks(data) {
  await chrome.storage.local.set({ [BM_KEY]: data });
}

export async function deleteBookmarkItem(liveId, createdAt) {
  const all = await readAllBookmarks();
  const entry = all[liveId];
  if (!entry) return all;
  entry.items = (entry.items || []).filter((x) => x.createdAt !== createdAt);
  if (!entry.items.length) delete all[liveId];
  await writeAllBookmarks(all);
  return all;
}

export async function updateBookmarkLabel(liveId, createdAt, label) {
  const all = await readAllBookmarks();
  const entry = all[liveId];
  if (!entry) return all;
  const item = (entry.items || []).find((x) => x.createdAt === createdAt);
  if (item) item.label = label;
  await writeAllBookmarks(all);
  return all;
}

export async function deleteBookmarkEntry(liveId) {
  const all = await readAllBookmarks();
  delete all[liveId];
  await writeAllBookmarks(all);
  return all;
}
