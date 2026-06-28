import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type DragCancelEvent,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import {
  ContextMenu,
  FavoritesBar,
  PinnedTree,
  SidebarFooter,
  TemporaryTabs,
  type PinnedTreeActions,
  type TabActions,
} from './components';
import { favoriteItems, findPinnedItem, sidebarItems } from './tree';
import type {
  ArchivedTab,
  ContextMenuState,
  DragItem,
  DropTarget,
  PinnedItem,
  PinnedLink,
  TabRowViewModel,
} from './types';

export interface SidebarAppProps {
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  color: string;
  pinnedItems: PinnedItem[];
  rowByItemId: Record<string, TabRowViewModel>;
  temporaryRows: TabRowViewModel[];
  expandedFolderIds: Set<string>;
  menu: ContextMenuState;
  archivedTabs: ArchivedTab[];
  archiveOpen: boolean;
  tabActions: TabActions;
  treeActions: PinnedTreeActions;
  onDragEnd(active: DragItem, target: DropTarget): void | Promise<void>;
  onCleanAll(): void;
  onNewTab(): void;
  onMenuClose(): void;
  onMenuRename(): void;
  onMenuCloseTab(): void;
  onMenuCloseTabsBelow(): void;
  onMenuToggleFavorite(): void;
  onMenuTogglePinned(): void;
  onMenuReplaceUrl(): void;
  onMenuNewFolder(): void;
  onMenuDeleteFolder(): void;
  onColorChange(color: string): void;
  onToggleArchive(): void;
  onRestoreArchive(tab: ArchivedTab): void;
  onNewFolder(): void;
  onOpenSettings(): void;
}

export function SidebarApp(props: SidebarAppProps) {
  const [activeDrag, setActiveDrag] = useState<DragItem | null>(null);
  const layoutPositions = useRef(new Map<string, DOMRect>());
  const animateNextLayout = useRef(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  useLayoutEffect(() => {
    const elements = Array.from(
      document.querySelectorAll<HTMLElement>('[data-layout-key]'),
    );
    const nextPositions = new Map<string, DOMRect>();
    let moved = false;
    for (const element of elements) {
      const key = element.dataset.layoutKey;
      if (!key) continue;
      const next = element.getBoundingClientRect();
      nextPositions.set(key, next);
      const previous = layoutPositions.current.get(key);
      if (!animateNextLayout.current || !previous) continue;
      const x = previous.left - next.left;
      const y = previous.top - next.top;
      if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) continue;
      moved = true;
      element.animate(
        [
          { transform: `translate(${x}px, ${y}px)` },
          { transform: 'translate(0, 0)' },
        ],
        {
          duration: 180,
          easing: 'cubic-bezier(0.2, 0.75, 0.25, 1)',
        },
      );
    }
    layoutPositions.current = nextPositions;
    if (moved) animateNextLayout.current = false;
  });

  if (props.status === 'loading') {
    return <div className="sidebar-loading">Loading Arcify…</div>;
  }
  if (props.status === 'error') {
    return <div className="sidebar-error">{props.error || 'Unable to load Arcify.'}</div>;
  }

  const favorites = favoriteItems(props.pinnedItems)
    .map(item => ({ item, row: props.rowByItemId[item.id] }))
    .filter(
      (entry): entry is { item: PinnedLink; row: TabRowViewModel } =>
        Boolean(entry.row),
    );
  const pinned = sidebarItems(props.pinnedItems);
  const style = {
    '--collection-bg-color': 'var(--sidebar-surface)',
    '--collection-bg-color-dark': 'var(--sidebar-surface-hover)',
  } as CSSProperties;

  const handleDragEnd = async (event: DragEndEvent) => {
    const active = event.active.data.current as DragItem | undefined;
    const target = event.over?.data.current as DropTarget | undefined;
    if (active && target) {
      animateNextLayout.current = true;
      await props.onDragEnd(active, target);
    }
    setActiveDrag(null);
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveDrag((event.active.data.current as DragItem | undefined) || null);
  };

  const handleDragCancel = (_event: DragCancelEvent) => setActiveDrag(null);

  const dragPreview = (() => {
    if (!activeDrag) return null;
    if (activeDrag.kind === 'temporary') {
      const row = props.temporaryRows.find(tab => tab.tabId === activeDrag.tabId);
      return row ? (
        <div className="drag-overlay-preview tab">
          <img className="tab-favicon" src={row.faviconUrl} alt="" />
          <span>{row.title}</span>
        </div>
      ) : null;
    }
    const item = findPinnedItem(props.pinnedItems, activeDrag.itemId);
    if (!item) return null;
    if (item.type === 'folder') {
      return <div className="drag-overlay-preview folder-header">{item.title}</div>;
    }
    const row = props.rowByItemId[item.id];
    return row ? (
      <div className="drag-overlay-preview tab">
        <img className="tab-favicon" src={row.faviconUrl} alt="" />
        <span>{row.title}</span>
      </div>
    ) : null;
  })();

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={handleDragStart}
      onDragCancel={handleDragCancel}
      onDragEnd={handleDragEnd}
    >
      <div className="sidebar-container" style={style}>
        <FavoritesBar favorites={favorites} actions={props.tabActions} />
        <div className="tabs-view collections-list">
          <div className="sidebar-view collection">
            <div className="sidebar-content collection-content">
              <div className="pinned-tabs">
                <PinnedTree
                  items={pinned}
                  expandedFolderIds={props.expandedFolderIds}
                  rowByItemId={props.rowByItemId}
                  actions={props.treeActions}
                />
              </div>
              <TemporaryTabs
                tabs={props.temporaryRows}
                actions={props.tabActions}
                onCleanAll={props.onCleanAll}
              />
            </div>
            <SidebarFooter
              color={props.color}
              archiveOpen={props.archiveOpen}
              archivedTabs={props.archivedTabs}
              onColorChange={props.onColorChange}
              onToggleArchive={props.onToggleArchive}
              onRestore={props.onRestoreArchive}
              onNewFolder={props.onNewFolder}
              onOpenSettings={props.onOpenSettings}
            />
          </div>
        </div>
        <div className="new-tab-btn-container">
          <button className="new-tab-btn" onClick={props.onNewTab}>
            <span>+</span> New Tab
          </button>
        </div>
        <ContextMenu
          menu={props.menu}
          onClose={props.onMenuClose}
          onRename={props.onMenuRename}
          onCloseTab={props.onMenuCloseTab}
          onCloseTabsBelow={props.onMenuCloseTabsBelow}
          onToggleFavorite={props.onMenuToggleFavorite}
          onTogglePinned={props.onMenuTogglePinned}
          onReplaceUrl={props.onMenuReplaceUrl}
          onNewFolder={props.onMenuNewFolder}
          onDeleteFolder={props.onMenuDeleteFolder}
        />
      </div>
      <DragOverlay dropAnimation={null}>{dragPreview}</DragOverlay>
    </DndContext>
  );
}
