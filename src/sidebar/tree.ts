import type {
  ItemPlacement,
  PinnedFolder,
  PinnedItem,
  PinnedItemLocation,
  PinnedLink,
} from './types';

export function walkPinnedItems(
  items: PinnedItem[],
  visitor: (item: PinnedItem, parent: PinnedFolder | null) => void,
  parent: PinnedFolder | null = null,
): void {
  for (const item of items) {
    visitor(item, parent);
    if (item.type === 'folder') walkPinnedItems(item.children, visitor, item);
  }
}

export function findPinnedItem(items: PinnedItem[], id: string): PinnedItem | null {
  for (const item of items) {
    if (item.id === id) return item;
    if (item.type === 'folder') {
      const found = findPinnedItem(item.children, id);
      if (found) return found;
    }
  }
  return null;
}

export function findPinnedLink(items: PinnedItem[], id: string): PinnedLink | null {
  const item = findPinnedItem(items, id);
  return item?.type === 'link' ? item : null;
}

export function isInsideCollapsedFolder(
  items: PinnedItem[],
  id: string,
  expandedFolderIds: Set<string>,
  ancestorCollapsed = false,
): boolean {
  for (const item of items) {
    if (item.id === id) return ancestorCollapsed;
    if (item.type === 'folder') {
      const result = isInsideCollapsedFolder(
        item.children,
        id,
        expandedFolderIds,
        ancestorCollapsed || !expandedFolderIds.has(item.id),
      );
      if (result) return true;
      if (findPinnedItem(item.children, id)) return false;
    }
  }
  return false;
}

export function updatePinnedItem(
  items: PinnedItem[],
  id: string,
  updater: (item: PinnedItem) => PinnedItem,
): PinnedItem[] {
  return items.map(item => {
    if (item.id === id) return updater(item);
    if (item.type === 'folder') {
      return { ...item, children: updatePinnedItem(item.children, id, updater) };
    }
    return item;
  });
}

export function findItemLocation(
  items: PinnedItem[],
  id: string,
  parentId: string | null = null,
): PinnedItemLocation | null {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.id === id) {
      const placement = item.type === 'link' ? item.placement : 'sidebar';
      const placementIndex = parentId === null
        ? items.slice(0, index).filter(candidate => {
            const candidatePlacement =
              candidate.type === 'link' ? candidate.placement : 'sidebar';
            return candidatePlacement === placement;
          }).length
        : index;
      return {
        parentId,
        index: placementIndex,
        placement,
      };
    }
    if (item.type === 'folder') {
      const found = findItemLocation(item.children, id, item.id);
      if (found) return found;
    }
  }
  return null;
}

export function removePinnedItem(
  items: PinnedItem[],
  id: string,
): { items: PinnedItem[]; removed: PinnedItem | null } {
  let removed: PinnedItem | null = null;
  const next: PinnedItem[] = [];
  for (const item of items) {
    if (item.id === id) {
      removed = item;
      continue;
    }
    if (item.type === 'folder') {
      const childResult = removePinnedItem(item.children, id);
      if (childResult.removed) removed = childResult.removed;
      next.push({ ...item, children: childResult.items });
      continue;
    }
    next.push(item);
  }
  return { items: next, removed };
}

function insertIntoParent(
  items: PinnedItem[],
  parentId: string,
  item: PinnedItem,
  index: number,
): PinnedItem[] {
  return items.map(candidate => {
    if (candidate.type !== 'folder') return candidate;
    if (candidate.id === parentId) {
      const children = [...candidate.children];
      children.splice(Math.max(0, Math.min(index, children.length)), 0, item);
      return { ...candidate, children };
    }
    return {
      ...candidate,
      children: insertIntoParent(candidate.children, parentId, item, index),
    };
  });
}

export function insertPinnedItem(
  items: PinnedItem[],
  item: PinnedItem,
  parentId: string | null,
  index: number,
  placement: ItemPlacement = 'sidebar',
): PinnedItem[] {
  const normalized = item.type === 'link' ? { ...item, placement } : item;
  if (placement === 'favorite') {
    const favoriteCount = items.filter(
      candidate => candidate.type === 'link' && candidate.placement === 'favorite',
    ).length;
    const next = [...items];
    next.splice(Math.max(0, Math.min(index, favoriteCount)), 0, normalized);
    return next;
  }
  if (!parentId) {
    const favorites = items.filter(
      candidate => candidate.type === 'link' && candidate.placement === 'favorite',
    );
    const sidebar = items.filter(
      candidate => candidate.type !== 'link' || candidate.placement !== 'favorite',
    );
    sidebar.splice(Math.max(0, Math.min(index, sidebar.length)), 0, normalized);
    return [...favorites, ...sidebar];
  }
  return insertIntoParent(items, parentId, normalized, index);
}

export function movePinnedItem(
  items: PinnedItem[],
  itemId: string,
  parentId: string | null,
  index: number,
  placement: ItemPlacement,
): PinnedItem[] {
  const item = findPinnedItem(items, itemId);
  if (!item) return items;
  if (item.type === 'folder' && parentId && containsFolder(item, parentId)) return items;

  const current = findItemLocation(items, itemId);
  const removed = removePinnedItem(items, itemId);
  if (!removed.removed) return items;
  const adjustedIndex =
    current &&
    current.parentId === parentId &&
    current.placement === placement &&
    current.index < index
      ? index - 1
      : index;
  return insertPinnedItem(removed.items, removed.removed, parentId, adjustedIndex, placement);
}

export function containsFolder(folder: PinnedFolder, targetId: string): boolean {
  if (folder.id === targetId) return true;
  return folder.children.some(
    child => child.type === 'folder' && containsFolder(child, targetId),
  );
}

export function flattenPinnedLinks(items: PinnedItem[]): PinnedLink[] {
  const links: PinnedLink[] = [];
  walkPinnedItems(items, item => {
    if (item.type === 'link') links.push(item);
  });
  return links;
}

export function sidebarItems(items: PinnedItem[]): PinnedItem[] {
  return items.filter(item => item.type !== 'link' || item.placement !== 'favorite');
}

export function favoriteItems(items: PinnedItem[]): PinnedLink[] {
  return items.filter(
    (item): item is PinnedLink => item.type === 'link' && item.placement === 'favorite',
  );
}
