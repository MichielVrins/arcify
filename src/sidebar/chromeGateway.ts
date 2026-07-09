import type { PinnedLink, RuntimeMessageMap, TabSnapshot } from './types';

type SplitViewTab = chrome.tabs.Tab & { splitViewId?: number };

function toSnapshot(tab: chrome.tabs.Tab): TabSnapshot | null {
  if (
    tab.id == null ||
    tab.windowId == null ||
    tab.index == null
  ) {
    return null;
  }
  const url = tab.url || tab.pendingUrl || `about:blank#arcify-tab-${tab.id}`;
  const splitViewId = (tab as SplitViewTab).splitViewId;
  return {
    id: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    title: tab.title || 'New Tab',
    url,
    favIconUrl: tab.favIconUrl,
    splitViewId: typeof splitViewId === 'number' && splitViewId >= 0 ? splitViewId : null,
    active: Boolean(tab.active),
    audible: Boolean(tab.audible),
    discarded: Boolean(tab.discarded),
  };
}

export async function queryCurrentWindowTabs(): Promise<TabSnapshot[]> {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return tabs.map(toSnapshot).filter((tab): tab is TabSnapshot => Boolean(tab));
}

export async function activateTab(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) {
    await chrome.tabs.highlight({
      windowId: tab.windowId,
      tabs: tab.index,
    });
  }
}

export async function createTab(url?: string): Promise<TabSnapshot> {
  const tab = await chrome.tabs.create({ url, active: true });
  const snapshot = toSnapshot(tab);
  if (!snapshot) throw new Error('Chrome created a tab without a usable ID or URL');
  return snapshot;
}

export async function closeTabSafely(tabId: number): Promise<void> {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  if (tabs.length === 1 && tabs[0]?.id === tabId) {
    await chrome.tabs.create({ active: true });
  }
  await chrome.tabs.remove(tabId);
}

export async function closeTabsSafely(tabIds: number[]): Promise<void> {
  if (tabIds.length === 0) return;
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const remaining = tabs.filter(tab => tab.id != null && !tabIds.includes(tab.id));
  if (remaining.length === 0) await chrome.tabs.create({ active: true });
  await chrome.tabs.remove(tabIds);
}

export function faviconUrl(url: string, size = 32): string {
  const favicon = new URL(chrome.runtime.getURL('/_favicon/'));
  favicon.searchParams.set('pageUrl', url);
  favicon.searchParams.set('size', String(size));
  return favicon.toString();
}

export async function sendRuntimeMessage<K extends keyof RuntimeMessageMap>(
  message: RuntimeMessageMap[K],
): Promise<void> {
  await chrome.runtime.sendMessage(message);
}

export async function bindPinnedTab(tabId: number, item: PinnedLink): Promise<void> {
  const stored = await chrome.storage.local.get('pinnedTabStatesById');
  const states = (stored.pinnedTabStatesById || {}) as Record<
    number,
    { pinnedItemId: string; pinnedUrl: string }
  >;
  states[tabId] = { pinnedItemId: item.id, pinnedUrl: item.url };
  await chrome.storage.local.set({ pinnedTabStatesById: states });
  await sendRuntimeMessage({
    action: 'ensurePinnedNavigationGuard',
    tabId,
  });
}

export async function unbindPinnedTab(tabId: number): Promise<void> {
  const stored = await chrome.storage.local.get('pinnedTabStatesById');
  const states = (stored.pinnedTabStatesById || {}) as Record<number, unknown>;
  delete states[tabId];
  await chrome.storage.local.set({ pinnedTabStatesById: states });
}

export async function replacePinnedBindings(
  itemIdByTabId: Record<number, string>,
  pinnedUrlsByItemId: Record<string, string>,
  currentWindowTabIds: number[],
): Promise<void> {
  const stored = await chrome.storage.local.get('pinnedTabStatesById');
  const currentWindowTabs = new Set(currentWindowTabIds.map(String));
  const existing = (stored.pinnedTabStatesById || {}) as Record<
    string,
    { pinnedItemId: string; pinnedUrl: string }
  >;
  const otherWindowStates = Object.fromEntries(
    Object.entries(existing).filter(([tabId]) => !currentWindowTabs.has(tabId)),
  );
  const currentWindowStates = Object.fromEntries(
    Object.entries(itemIdByTabId)
      .filter(([, itemId]) => Boolean(pinnedUrlsByItemId[itemId]))
      .map(([tabId, itemId]) => [
        tabId,
        { pinnedItemId: itemId, pinnedUrl: pinnedUrlsByItemId[itemId] },
      ]),
  );
  await chrome.storage.local.set({
    pinnedTabStatesById: { ...otherWindowStates, ...currentWindowStates },
  });
}

export interface ChromeTabEventHandlers {
  onChanged: () => void;
  onCreated?: (tab: chrome.tabs.Tab) => void;
}

export function subscribeToChromeTabs({
  onChanged,
  onCreated,
}: ChromeTabEventHandlers): () => void {
  const created = (tab: chrome.tabs.Tab) => {
    onCreated?.(tab);
    onChanged();
  };
  const updated = () => onChanged();
  const removed = () => onChanged();
  const moved = () => onChanged();
  const activated = () => onChanged();
  chrome.tabs.onCreated.addListener(created);
  chrome.tabs.onUpdated.addListener(updated);
  chrome.tabs.onRemoved.addListener(removed);
  chrome.tabs.onMoved.addListener(moved);
  chrome.tabs.onActivated.addListener(activated);
  return () => {
    chrome.tabs.onCreated.removeListener(created);
    chrome.tabs.onUpdated.removeListener(updated);
    chrome.tabs.onRemoved.removeListener(removed);
    chrome.tabs.onMoved.removeListener(moved);
    chrome.tabs.onActivated.removeListener(activated);
  };
}
