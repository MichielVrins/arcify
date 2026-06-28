export type ItemPlacement = 'sidebar' | 'favorite';

export interface PinnedLink {
  id: string;
  type: 'link';
  title: string;
  url: string;
  customTitle: boolean;
  placement: ItemPlacement;
}

export interface PinnedFolder {
  id: string;
  type: 'folder';
  title: string;
  children: PinnedItem[];
}

export type PinnedItem = PinnedLink | PinnedFolder;

export interface DurableSidebarState {
  version: 2;
  color: string;
  pinnedItems: PinnedItem[];
}

export interface TabSnapshot {
  id: number;
  windowId: number;
  index: number;
  title: string;
  url: string;
  favIconUrl?: string;
  active: boolean;
  audible: boolean;
  discarded: boolean;
}

export interface RuntimeSidebarState {
  tabs: TabSnapshot[];
  activeTabId: number | null;
  tabIdByItemId: Record<string, number>;
  itemIdByTabId: Record<number, string>;
  expandedFolderIds: string[];
  temporaryTitles: Record<number, string>;
}

export interface SidebarState {
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  durable: DurableSidebarState;
  runtime: RuntimeSidebarState;
}

export interface PinnedItemLocation {
  parentId: string | null;
  index: number;
  placement: ItemPlacement;
}

export type DragItem =
  | { kind: 'pinned'; itemId: string }
  | { kind: 'temporary'; tabId: number };

export type DropTarget =
  | { area: 'favorite'; index: number }
  | { area: 'pinned'; parentId: string | null; index: number }
  | { area: 'temporary'; index: number };

export interface TabRowViewModel {
  key: string;
  tabId: number | null;
  itemId: string | null;
  title: string;
  url: string;
  pinnedUrl: string | null;
  faviconUrl: string;
  active: boolean;
  pinned: boolean;
  favorite: boolean;
  open: boolean;
  navigatedAway: boolean;
}

export type ContextMenuState =
  | { kind: 'tab'; x: number; y: number; row: TabRowViewModel }
  | { kind: 'folder'; x: number; y: number; folderId: string }
  | null;

export interface ArchivedTab {
  url: string;
  name: string;
  archivedAt: number;
}

export interface RuntimeMessageMap {
  ensurePinnedNavigationGuard: { action: 'ensurePinnedNavigationGuard'; tabId: number };
  toggleSpotlightNewTab: { command: 'toggleSpotlightNewTab' };
}
