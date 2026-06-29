import { useCallback, useEffect, useRef, useState } from 'react';
import { SidebarApp } from './App';
import type { PinnedTreeActions, TabActions } from './components';
import {
  activateTab,
  bindPinnedTab,
  closeTabSafely,
  closeTabsSafely,
  createTab,
  faviconUrl,
  moveNativeTab,
  queryCurrentWindowTabs,
  replacePinnedBindings,
  sendRuntimeMessage,
  subscribeToChromeTabs,
  unbindPinnedTab,
} from './chromeGateway';
import { isNavigatedAway, reconcileTabs } from './reconcile';
import { useSidebarContext } from './state';
import {
  loadArchivedTabs,
  loadDurableState,
  saveArchivedTabs,
  saveDurableState,
} from './storage';
import {
  favoriteItems,
  findPinnedItem,
  findPinnedLink,
  flattenPinnedLinks,
  insertPinnedItem,
  isInsideCollapsedFolder,
  movePinnedItem,
  removePinnedItem,
  sidebarItems,
  updatePinnedItem,
} from './tree';
import type {
  ArchivedTab,
  ContextMenuState,
  DragItem,
  DropTarget,
  DurableSidebarState,
  PinnedFolder,
  PinnedItem,
  PinnedLink,
  TabRowViewModel,
  TabSnapshot,
} from './types';

function createLink(tab: TabSnapshot, placement: 'sidebar' | 'favorite'): PinnedLink {
  return {
    id: crypto.randomUUID(),
    type: 'link',
    title: tab.title,
    url: tab.url,
    customTitle: false,
    placement,
  };
}

function pinnedUrlsByItemId(items: PinnedItem[]): Record<string, string> {
  return Object.fromEntries(flattenPinnedLinks(items).map(item => [item.id, item.url]));
}

export function SidebarController() {
  const { state, dispatch } = useSidebarContext();
  const [menu, setMenu] = useState<ContextMenuState>(null);
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archivedTabs, setArchivedTabs] = useState<ArchivedTab[]>([]);
  const [closingKeys, setClosingKeys] = useState<string[]>([]);
  const [surfaceColor, setSurfaceColor] = useState<string | null>(null);
  const refreshSequence = useRef(0);
  const liveOwnership = useRef<Record<number, string>>({});
  const spotlightRelayTabId = useRef<number | null>(null);

  useEffect(() => {
    void chrome.storage.sync.get('sidebarSurfaceColor').then(result => {
      setSurfaceColor(
        typeof result.sidebarSurfaceColor === 'string'
          ? result.sidebarSurfaceColor
          : null,
      );
    });
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== 'sync' || !changes.sidebarSurfaceColor) return;
      const value = changes.sidebarSurfaceColor.newValue;
      setSurfaceColor(typeof value === 'string' ? value : null);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  const rememberOwnership = (tabId: number, itemId: string | null) => {
    if (itemId) liveOwnership.current[tabId] = itemId;
    else delete liveOwnership.current[tabId];
  };

  const synchronizeTabs = useCallback(
    async (durable: DurableSidebarState) => {
      const sequence = ++refreshSequence.current;
      const tabs = await queryCurrentWindowTabs();
      if (sequence !== refreshSequence.current) return;
      const ownership = reconcileTabs(
        durable,
        tabs,
        liveOwnership.current,
        false,
      );
      liveOwnership.current = ownership.itemIdByTabId;
      dispatch({ type: 'tabsSynchronized', tabs, ...ownership });
      await replacePinnedBindings(
        ownership.itemIdByTabId,
        pinnedUrlsByItemId(durable.pinnedItems),
        tabs.map(tab => tab.id),
      );
    },
    [dispatch],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [durable, tabs, archive] = await Promise.all([
          loadDurableState(),
          queryCurrentWindowTabs(),
          loadArchivedTabs(),
        ]);
        if (cancelled) return;
        const ownership = reconcileTabs(durable, tabs, {});
        liveOwnership.current = ownership.itemIdByTabId;
        dispatch({ type: 'initialized', durable, tabs, ...ownership });
        setArchivedTabs(archive);
        await replacePinnedBindings(
          ownership.itemIdByTabId,
          pinnedUrlsByItemId(durable.pinnedItems),
          tabs.map(tab => tab.id),
        );
      } catch (error) {
        dispatch({
          type: 'initializationFailed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dispatch]);

  useEffect(() => {
    if (state.status !== 'ready') return;
    void saveDurableState(state.durable);
  }, [state.durable, state.status]);

  useEffect(() => {
    if (state.status !== 'ready') return;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    return subscribeToChromeTabs({
      onChanged: () => {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(() => void synchronizeTabs(state.durable), 40);
      },
    });
  }, [state.durable, state.status, synchronizeTabs]);

  useEffect(() => {
    const updateRelay = (message: {
      action?: string;
      tabId?: number;
      pinnedItemId?: string;
    }) => {
      if (message.action === 'spotlightRelayStarted' && message.tabId != null) {
        spotlightRelayTabId.current = message.tabId;
      } else if (
        message.action === 'spotlightRelayStopped' &&
        message.tabId === spotlightRelayTabId.current
      ) {
        spotlightRelayTabId.current = null;
      } else if (
        message.action === 'pinnedTabOpened' &&
        message.tabId != null &&
        message.pinnedItemId
      ) {
        liveOwnership.current[message.tabId] = message.pinnedItemId;
      }
    };
    const relayKey = (event: KeyboardEvent) => {
      const tabId = spotlightRelayTabId.current;
      if (tabId == null || event.isComposing) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      chrome.tabs.sendMessage(tabId, {
        action: 'spotlightRelayKey',
        keyEvent: {
          key: event.key,
          code: event.code,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
        },
      }).catch(() => {
        if (spotlightRelayTabId.current === tabId) spotlightRelayTabId.current = null;
      });
    };
    chrome.runtime.onMessage.addListener(updateRelay);
    window.addEventListener('keydown', relayKey, true);
    return () => {
      chrome.runtime.onMessage.removeListener(updateRelay);
      window.removeEventListener('keydown', relayKey, true);
    };
  }, []);

  const commitDurable = useCallback(
    async (durable: DurableSidebarState) => {
      dispatch({ type: 'replaceDurable', durable });
      await synchronizeTabs(durable);
    },
    [dispatch, synchronizeTabs],
  );

  const tabById = Object.fromEntries(state.runtime.tabs.map(tab => [tab.id, tab]));
  const rowByItemId: Record<string, TabRowViewModel> = {};
  const pinnedLinks = flattenPinnedLinks(state.durable.pinnedItems);
  const pinnedLinkIds = new Set(pinnedLinks.map(item => item.id));
  for (const item of pinnedLinks) {
    const tabId = state.runtime.tabIdByItemId[item.id] ?? null;
    const tab = tabId ? tabById[tabId] : null;
    rowByItemId[item.id] = {
      key: item.id,
      tabId,
      itemId: item.id,
      title: item.customTitle ? item.title : (tab?.title || item.title),
      url: tab?.url || item.url,
      pinnedUrl: item.url,
      faviconUrl: faviconUrl(tab?.url || item.url),
      active: Boolean(tab?.active),
      pinned: true,
      favorite: item.placement === 'favorite',
      open: Boolean(tab),
      navigatedAway: Boolean(tab && isNavigatedAway(tab.url, item.url)),
    };
  }
  const temporaryRows: TabRowViewModel[] = state.runtime.tabs
    .filter(tab => {
      const ownerId = state.runtime.itemIdByTabId[tab.id];
      return !ownerId || !pinnedLinkIds.has(ownerId);
    })
    .map(tab => ({
      key: `temporary:${tab.id}`,
      tabId: tab.id,
      itemId: null,
      title: state.runtime.temporaryTitles[tab.id] || tab.title,
      url: tab.url,
      pinnedUrl: null,
      faviconUrl: faviconUrl(tab.url),
      active: tab.active,
      pinned: false,
      favorite: false,
      open: true,
      navigatedAway: false,
    }));

  const activateRow = useCallback(
    async (row: TabRowViewModel) => {
      if (row.tabId) {
        await activateTab(row.tabId);
        return;
      }
      if (!row.itemId) return;
      const item = findPinnedLink(state.durable.pinnedItems, row.itemId);
      if (!item) return;
      const tab = await createTab(item.url);
      await bindPinnedTab(tab.id, item);
      rememberOwnership(tab.id, item.id);
      await synchronizeTabs(state.durable);
    },
    [state.durable, synchronizeTabs],
  );

  const closeRow = useCallback(
    async (row: TabRowViewModel) => {
      const shouldCollapse =
        !row.pinned ||
        Boolean(
          row.itemId &&
          isInsideCollapsedFolder(
            state.durable.pinnedItems,
            row.itemId,
            new Set(state.runtime.expandedFolderIds),
          ),
        );
      if (shouldCollapse) {
        setClosingKeys(keys => [...new Set([...keys, row.key])]);
        await new Promise(resolve => setTimeout(resolve, 140));
      }
      if (row.tabId) {
        try {
          await closeTabSafely(row.tabId);
          await unbindPinnedTab(row.tabId);
          rememberOwnership(row.tabId, null);
          await synchronizeTabs(state.durable);
          return;
        } finally {
          setClosingKeys(keys => keys.filter(key => key !== row.key));
        }
      }
      if (!row.itemId) return;
      try {
        const nextItems = removePinnedItem(state.durable.pinnedItems, row.itemId).items;
        await commitDurable({ ...state.durable, pinnedItems: nextItems });
      } finally {
        setClosingKeys(keys => keys.filter(key => key !== row.key));
      }
    },
    [commitDurable, state.durable, state.runtime.expandedFolderIds, synchronizeTabs],
  );

  const tabActions: TabActions = {
    renamingKey,
    closingKeys: new Set(closingKeys),
    onActivate: row => void activateRow(row),
    onClose: row => void closeRow(row),
    onContextMenu: (row, x, y) => setMenu({ kind: 'tab', row, x, y }),
    onRenameCommit: (key, title) => {
      if (key.startsWith('new-folder:')) {
        const encodedParent = key.slice('new-folder:'.length);
        createFolder(encodedParent === 'root' ? null : encodedParent, title);
      } else if (key.startsWith('item:')) {
        dispatch({ type: 'renameItem', itemId: key.slice(5), title });
      } else if (key.startsWith('tab:')) {
        dispatch({ type: 'renameTemporary', tabId: Number(key.slice(4)), title });
      }
      setRenamingKey(null);
    },
    onRenameCancel: () => setRenamingKey(null),
  };

  const treeActions: PinnedTreeActions = {
    ...tabActions,
    onToggleFolder: folderId => dispatch({ type: 'toggleFolder', folderId }),
    onFolderContextMenu: (folderId, x, y) =>
      setMenu({ kind: 'folder', folderId, x, y }),
  };

  const handleDragEnd = useCallback(
    async (active: DragItem, target: DropTarget) => {
      if (active.kind === 'pinned') {
        const item = findPinnedItem(state.durable.pinnedItems, active.itemId);
        if (!item) return;
        if (target.area === 'temporary') {
          if (item.type !== 'link') return;
          const tabId = state.runtime.tabIdByItemId[item.id];
          if (!tabId) return;
          const next = removePinnedItem(state.durable.pinnedItems, item.id).items;
          await unbindPinnedTab(tabId);
          rememberOwnership(tabId, null);
          await commitDurable({ ...state.durable, pinnedItems: next });
          return;
        }
        const placement = target.area === 'favorite' ? 'favorite' : 'sidebar';
        const next = movePinnedItem(
          state.durable.pinnedItems,
          item.id,
          target.area === 'pinned' ? target.parentId : null,
          target.index,
          placement,
        );
        await commitDurable({ ...state.durable, pinnedItems: next });
        return;
      }

      const tab = tabById[active.tabId];
      if (!tab) return;
      if (target.area === 'temporary') {
        const targetRow = temporaryRows[target.index];
        const targetTab = targetRow?.tabId ? tabById[targetRow.tabId] : null;
        const targetIndex = targetTab
          ? targetTab.index - (tab.index < targetTab.index ? 1 : 0)
          : -1;
        await moveNativeTab(tab.id, targetIndex);
        return;
      }
      const placement = target.area === 'favorite' ? 'favorite' : 'sidebar';
      const link = createLink(tab, placement);
      const next = insertPinnedItem(
        state.durable.pinnedItems,
        link,
        target.area === 'pinned' ? target.parentId : null,
        target.index,
        placement,
      );
      await bindPinnedTab(tab.id, link);
      rememberOwnership(tab.id, link.id);
      await commitDurable({ ...state.durable, pinnedItems: next });
    },
    [commitDurable, state, tabById, temporaryRows],
  );

  const selectedItem =
    menu?.kind === 'tab' && menu.row.itemId
      ? findPinnedItem(state.durable.pinnedItems, menu.row.itemId)
      : menu?.kind === 'folder'
        ? findPinnedItem(state.durable.pinnedItems, menu.folderId)
        : null;

  const renameSelected = () => {
    if (selectedItem) {
      setRenamingKey(`item:${selectedItem.id}`);
      return;
    }
    if (menu?.kind === 'tab' && menu.row.tabId) {
      setRenamingKey(`tab:${menu.row.tabId}`);
    }
  };

  const toggleFavorite = () => {
    if (menu?.kind !== 'tab' || !menu.row.itemId) return;
    const target = menu.row.favorite ? 'sidebar' : 'favorite';
    const index =
      target === 'favorite'
        ? favoriteItems(state.durable.pinnedItems).length
        : sidebarItems(state.durable.pinnedItems).length;
    dispatch({
      type: 'movePinnedItem',
      itemId: menu.row.itemId,
      parentId: null,
      index,
      placement: target,
    });
  };

  const togglePinned = async () => {
    if (menu?.kind !== 'tab') return;
    if (menu.row.pinned) {
      await closeOrUnpin(false);
      return;
    }
    const tab = menu.row.tabId ? tabById[menu.row.tabId] : null;
    if (!tab) return;
    const link = createLink(tab, 'sidebar');
    await bindPinnedTab(tab.id, link);
    rememberOwnership(tab.id, link.id);
    await commitDurable({
      ...state.durable,
      pinnedItems: insertPinnedItem(
        state.durable.pinnedItems,
        link,
        null,
        sidebarItems(state.durable.pinnedItems).length,
      ),
    });
  };

  const closeOrUnpin = async (close: boolean) => {
    if (menu?.kind !== 'tab') return;
    if (close) {
      await closeRow(menu.row);
      return;
    }
    if (!menu.row.itemId) return;
    if (menu.row.tabId) {
      await unbindPinnedTab(menu.row.tabId);
      rememberOwnership(menu.row.tabId, null);
    }
    await commitDurable({
      ...state.durable,
      pinnedItems: removePinnedItem(
        state.durable.pinnedItems,
        menu.row.itemId,
      ).items,
    });
  };

  const closeTemporaryTabsBelow = async () => {
    if (menu?.kind !== 'tab' || menu.row.pinned || menu.row.tabId == null) return;
    const index = temporaryRows.findIndex(row => row.tabId === menu.row.tabId);
    if (index < 0) return;
    await closeTemporaryRows(temporaryRows.slice(index + 1));
  };

  const closeTemporaryRows = async (rows: TabRowViewModel[]) => {
    const tabIds = rows.flatMap(row => row.tabId == null ? [] : [row.tabId]);
    if (tabIds.length === 0) return;
    const keys = new Set(rows.map(row => row.key));
    setClosingKeys(current => [...new Set([...current, ...keys])]);
    await new Promise(resolve => setTimeout(resolve, 140));
    try {
      await closeTabsSafely(tabIds);
    } finally {
      setClosingKeys(current => current.filter(key => !keys.has(key)));
    }
  };

  const replacePinnedUrl = async () => {
    if (menu?.kind !== 'tab' || !menu.row.itemId || !menu.row.tabId) return;
    const tab = tabById[menu.row.tabId];
    if (!tab) return;
    const item = findPinnedLink(state.durable.pinnedItems, menu.row.itemId);
    if (!item) return;
    const nextItem = {
      ...item,
      url: tab.url,
      title: item.customTitle ? item.title : tab.title,
    };
    const nextItems = updatePinnedItem(
      state.durable.pinnedItems,
      item.id,
      () => nextItem,
    );
    await bindPinnedTab(tab.id, nextItem);
    await commitDurable({ ...state.durable, pinnedItems: nextItems });
  };

  function createFolder(parentId: string | null, title: string) {
    const folder: PinnedFolder = {
      id: crypto.randomUUID(),
      type: 'folder',
      title,
      children: [],
    };
    dispatch({
      type: 'insertPinnedItem',
      item: folder,
      parentId,
      index: parentId
        ? ((findPinnedItem(state.durable.pinnedItems, parentId) as PinnedFolder)?.children.length || 0)
        : sidebarItems(state.durable.pinnedItems).length,
      placement: 'sidebar',
    });
  }

  const beginCreateFolder = (parentId: string | null) => {
    if (parentId) {
      if (!state.runtime.expandedFolderIds.includes(parentId)) {
        dispatch({ type: 'toggleFolder', folderId: parentId });
      }
    }
    setRenamingKey(`new-folder:${parentId || 'root'}`);
  };

  return (
    <SidebarApp
      status={state.status}
      error={state.error}
      surfaceColor={surfaceColor}
      pinnedItems={state.durable.pinnedItems}
      rowByItemId={rowByItemId}
      temporaryRows={temporaryRows}
      expandedFolderIds={new Set(state.runtime.expandedFolderIds)}
      menu={menu}
      archivedTabs={archivedTabs}
      archiveOpen={archiveOpen}
      tabActions={tabActions}
      treeActions={treeActions}
      onDragEnd={handleDragEnd}
      onCleanAll={() => void closeTemporaryRows(temporaryRows)}
      onNewTab={() => void sendRuntimeMessage({ command: 'toggleSpotlightNewTab' })}
      onMenuClose={() => setMenu(null)}
      onMenuRename={renameSelected}
      onMenuCloseTab={() => void closeOrUnpin(true)}
      onMenuCloseTabsBelow={() => void closeTemporaryTabsBelow()}
      onMenuToggleFavorite={toggleFavorite}
      onMenuTogglePinned={() => void togglePinned()}
      onMenuReplaceUrl={() => void replacePinnedUrl()}
      onMenuNewFolder={() =>
        beginCreateFolder(menu?.kind === 'folder' ? menu.folderId : null)
      }
      onMenuDeleteFolder={() => {
        if (menu?.kind === 'folder') {
          void commitDurable({
            ...state.durable,
            pinnedItems: removePinnedItem(
              state.durable.pinnedItems,
              menu.folderId,
            ).items,
          });
        }
      }}
      onToggleArchive={() => setArchiveOpen(value => !value)}
      onRestoreArchive={tab =>
        void (async () => {
          await createTab(tab.url);
          const next = archivedTabs.filter(candidate => candidate !== tab);
          setArchivedTabs(next);
          await saveArchivedTabs(next);
        })()
      }
      onNewFolder={() => beginCreateFolder(null)}
      onOpenSettings={() => void chrome.runtime.openOptionsPage()}
    />
  );
}
