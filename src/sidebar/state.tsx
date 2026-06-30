import {
  createContext,
  useContext,
  useReducer,
  type Dispatch,
  type PropsWithChildren,
} from 'react';
import { defaultDurableState } from './storage';
import {
  findPinnedItem,
  insertPinnedItem,
  movePinnedItem,
  updatePinnedItem,
} from './tree';
import type {
  DurableSidebarState,
  ItemPlacement,
  PinnedFolder,
  PinnedItem,
  SidebarState,
  TabSnapshot,
} from './types';

export type SidebarAction =
  | {
      type: 'initialized';
      durable: DurableSidebarState;
      tabs: TabSnapshot[];
      tabIdByItemId: Record<string, number>;
      itemIdByTabId: Record<number, string>;
    }
  | {
      type: 'tabsSynchronized';
      tabs: TabSnapshot[];
      tabIdByItemId: Record<string, number>;
      itemIdByTabId: Record<number, string>;
      newTemporaryTabIds: number[];
      newTabPosition: 'top' | 'bottom';
    }
  | { type: 'initializationFailed'; error: string }
  | { type: 'toggleFolder'; folderId: string }
  | { type: 'replaceDurable'; durable: DurableSidebarState }
  | {
      type: 'movePinnedItem';
      itemId: string;
      parentId: string | null;
      index: number;
      placement: ItemPlacement;
    }
  | {
      type: 'insertPinnedItem';
      item: PinnedItem;
      parentId: string | null;
      index: number;
      placement: ItemPlacement;
    }
  | { type: 'renameItem'; itemId: string; title: string }
  | { type: 'renameTemporary'; tabId: number; title: string }
  | { type: 'moveTemporaryTab'; tabId: number; index: number };

const initialState: SidebarState = {
  status: 'loading',
  error: null,
  durable: defaultDurableState(),
  runtime: {
    tabs: [],
    temporaryTabOrder: [],
    activeTabId: null,
    tabIdByItemId: {},
    itemIdByTabId: {},
    expandedFolderIds: [],
    temporaryTitles: {},
  },
};

function reducer(state: SidebarState, action: SidebarAction): SidebarState {
  switch (action.type) {
    case 'initialized':
      return {
        status: 'ready',
        error: null,
        durable: action.durable,
        runtime: {
          ...state.runtime,
          tabs: action.tabs,
          temporaryTabOrder: action.tabs
            .filter(tab => !action.itemIdByTabId[tab.id])
            .map(tab => tab.id)
            .sort((left, right) => left - right),
          activeTabId: action.tabs.find(tab => tab.active)?.id ?? null,
          tabIdByItemId: action.tabIdByItemId,
          itemIdByTabId: action.itemIdByTabId,
        },
      };
    case 'tabsSynchronized': {
      const temporaryIds = new Set(
        action.tabs
          .filter(tab => !action.itemIdByTabId[tab.id])
          .map(tab => tab.id),
      );
      const retainedOrder = state.runtime.temporaryTabOrder.filter(id =>
        temporaryIds.has(id),
      );
      const knownIds = new Set(retainedOrder);
      const discoveredIds = action.tabs
        .map(tab => tab.id)
        .filter(id => temporaryIds.has(id) && !knownIds.has(id))
        .sort((left, right) => left - right);
      const explicitlyNew = new Set(action.newTemporaryTabIds);
      const regularDiscoveries = discoveredIds.filter(id => !explicitlyNew.has(id));
      const newIds = discoveredIds.filter(id => explicitlyNew.has(id));
      const temporaryTabOrder =
        action.newTabPosition === 'top'
          ? [...newIds, ...retainedOrder, ...regularDiscoveries]
          : [...retainedOrder, ...regularDiscoveries, ...newIds];
      return {
        ...state,
        runtime: {
          ...state.runtime,
          tabs: action.tabs,
          temporaryTabOrder,
          activeTabId: action.tabs.find(tab => tab.active)?.id ?? null,
          tabIdByItemId: action.tabIdByItemId,
          itemIdByTabId: action.itemIdByTabId,
        },
      };
    }
    case 'initializationFailed':
      return { ...state, status: 'error', error: action.error };
    case 'toggleFolder': {
      const expanded = new Set(state.runtime.expandedFolderIds);
      if (expanded.has(action.folderId)) expanded.delete(action.folderId);
      else expanded.add(action.folderId);
      return {
        ...state,
        runtime: { ...state.runtime, expandedFolderIds: [...expanded] },
      };
    }
    case 'replaceDurable':
      return { ...state, durable: action.durable };
    case 'movePinnedItem':
      return {
        ...state,
        durable: {
          ...state.durable,
          pinnedItems: movePinnedItem(
            state.durable.pinnedItems,
            action.itemId,
            action.parentId,
            action.index,
            action.placement,
          ),
        },
      };
    case 'insertPinnedItem':
      return {
        ...state,
        durable: {
          ...state.durable,
          pinnedItems: insertPinnedItem(
            state.durable.pinnedItems,
            action.item,
            action.parentId,
            action.index,
            action.placement,
          ),
        },
      };
    case 'renameItem':
      return {
        ...state,
        durable: {
          ...state.durable,
          pinnedItems: updatePinnedItem(state.durable.pinnedItems, action.itemId, item => {
            if (item.type === 'link') {
              return { ...item, title: action.title, customTitle: true };
            }
            return { ...item, title: action.title } satisfies PinnedFolder;
          }),
        },
      };
    case 'renameTemporary':
      return {
        ...state,
        runtime: {
          ...state.runtime,
          temporaryTitles: {
            ...state.runtime.temporaryTitles,
            [action.tabId]: action.title,
          },
        },
      };
    case 'moveTemporaryTab': {
      const currentIndex = state.runtime.temporaryTabOrder.indexOf(action.tabId);
      const order = state.runtime.temporaryTabOrder.filter(
        id => id !== action.tabId,
      );
      const targetIndex =
        currentIndex >= 0 && currentIndex < action.index
          ? action.index - 1
          : action.index;
      order.splice(Math.max(0, Math.min(targetIndex, order.length)), 0, action.tabId);
      return {
        ...state,
        runtime: { ...state.runtime, temporaryTabOrder: order },
      };
    }
    default:
      return state;
  }
}

interface SidebarContextValue {
  state: SidebarState;
  dispatch: Dispatch<SidebarAction>;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

export function SidebarProvider({ children }: PropsWithChildren) {
  const [state, dispatch] = useReducer(reducer, initialState);
  return (
    <SidebarContext.Provider value={{ state, dispatch }}>
      {children}
    </SidebarContext.Provider>
  );
}

export function useSidebarContext(): SidebarContextValue {
  const value = useContext(SidebarContext);
  if (!value) throw new Error('useSidebarContext must be used inside SidebarProvider');
  return value;
}

export function itemExists(state: SidebarState, itemId: string): boolean {
  return Boolean(findPinnedItem(state.durable.pinnedItems, itemId));
}
