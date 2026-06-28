import { flattenPinnedLinks } from './tree';
import type {
  DurableSidebarState,
  RuntimeSidebarState,
  TabSnapshot,
} from './types';

function urlKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split('#')[0].split('?')[0];
  }
}

export function reconcileTabs(
  durable: DurableSidebarState,
  tabs: TabSnapshot[],
  legacyBindings: Record<number, string>,
  allowUrlRecovery = true,
): Pick<RuntimeSidebarState, 'tabIdByItemId' | 'itemIdByTabId'> {
  const links = flattenPinnedLinks(durable.pinnedItems);
  const validItemIds = new Set(links.map(link => link.id));
  const claimedTabs = new Set<number>();
  const claimedItems = new Set<string>();
  const tabIdByItemId: Record<string, number> = {};
  const itemIdByTabId: Record<number, string> = {};

  for (const tab of tabs) {
    const itemId = legacyBindings[tab.id];
    if (
      !itemId ||
      !validItemIds.has(itemId) ||
      claimedTabs.has(tab.id) ||
      claimedItems.has(itemId)
    ) {
      continue;
    }
    tabIdByItemId[itemId] = tab.id;
    itemIdByTabId[tab.id] = itemId;
    claimedTabs.add(tab.id);
    claimedItems.add(itemId);
  }

  if (!allowUrlRecovery) {
    return { tabIdByItemId, itemIdByTabId };
  }

  for (const item of links) {
    if (claimedItems.has(item.id)) continue;
    const exact = tabs.filter(
      tab => !claimedTabs.has(tab.id) && tab.url === item.url,
    );
    const normalized =
      exact.length === 0
        ? tabs.filter(
            tab => !claimedTabs.has(tab.id) && urlKey(tab.url) === urlKey(item.url),
          )
        : [];
    const candidates = exact.length ? exact : normalized;
    if (candidates.length !== 1) continue;
    const tab = candidates[0];
    tabIdByItemId[item.id] = tab.id;
    itemIdByTabId[tab.id] = item.id;
    claimedTabs.add(tab.id);
    claimedItems.add(item.id);
  }

  return { tabIdByItemId, itemIdByTabId };
}

export function isNavigatedAway(currentUrl: string, pinnedUrl: string): boolean {
  return urlKey(currentUrl) !== urlKey(pinnedUrl);
}
