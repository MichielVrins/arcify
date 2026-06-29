import type { ArchivedTab, DurableSidebarState, PinnedItem } from './types';

const SIDEBAR_KEY = 'sidebarState';
const ARCHIVE_KEY = 'archivedTabs';

function normalizeItem(raw: unknown): PinnedItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const id = typeof item.id === 'string' ? item.id : crypto.randomUUID();
  const title = typeof item.title === 'string' && item.title ? item.title : 'Untitled';
  if (item.type === 'folder') {
    return {
      id,
      type: 'folder',
      title,
      children: Array.isArray(item.children)
        ? item.children.map(normalizeItem).filter((child): child is PinnedItem => Boolean(child))
        : [],
    };
  }
  return {
    id,
    type: 'link',
    title,
    url: typeof item.url === 'string' ? item.url : '',
    customTitle:
      typeof item.customTitle === 'boolean' ? item.customTitle : true,
    placement: item.placement === 'favorite' ? 'favorite' : 'sidebar',
  };
}

export function defaultDurableState(): DurableSidebarState {
  return { version: 2, pinnedItems: [] };
}

export async function loadDurableState(): Promise<DurableSidebarState> {
  const stored = await chrome.storage.local.get(SIDEBAR_KEY);
  const raw = stored[SIDEBAR_KEY] as Record<string, unknown> | undefined;
  if (!raw) return defaultDurableState();
  return {
    version: 2,
    pinnedItems: Array.isArray(raw.pinnedItems)
      ? raw.pinnedItems.map(normalizeItem).filter((item): item is PinnedItem => Boolean(item))
      : [],
  };
}

let saveQueue = Promise.resolve();

export function saveDurableState(state: DurableSidebarState): Promise<void> {
  const snapshot = structuredClone(state);
  saveQueue = saveQueue.catch(() => undefined).then(async () => {
    await chrome.storage.local.set({ [SIDEBAR_KEY]: snapshot });
  });
  return saveQueue;
}

export async function loadArchivedTabs(): Promise<ArchivedTab[]> {
  const stored = await chrome.storage.local.get(ARCHIVE_KEY);
  return Array.isArray(stored[ARCHIVE_KEY]) ? stored[ARCHIVE_KEY] : [];
}

export async function saveArchivedTabs(tabs: ArchivedTab[]): Promise<void> {
  await chrome.storage.local.set({ [ARCHIVE_KEY]: tabs });
}
