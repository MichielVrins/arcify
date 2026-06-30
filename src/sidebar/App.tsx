import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type DragCancelEvent,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import {
  ConfirmDialog,
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
  surfaceColor: string | null;
  pinnedItems: PinnedItem[];
  rowByItemId: Record<string, TabRowViewModel>;
  temporaryRows: TabRowViewModel[];
  expandedFolderIds: Set<string>;
  menu: ContextMenuState;
  archivedTabs: ArchivedTab[];
  archiveOpen: boolean;
  folderPendingDeletion: { id: string; title: string } | null;
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
  onCancelFolderDeletion(): void;
  onConfirmFolderDeletion(): void;
  onToggleArchive(): void;
  onRestoreArchive(tab: ArchivedTab): void;
  onNewFolder(): void;
  onOpenSettings(): void;
}

export function SidebarApp(props: SidebarAppProps) {
  const [activeDrag, setActiveDrag] = useState<DragItem | null>(null);
  const [dropIndicator, setDropIndicator] = useState<CSSProperties | null>(null);
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
    '--collection-bg-color': props.surfaceColor || 'var(--sidebar-surface)',
    '--collection-bg-color-dark': props.surfaceColor
      ? `color-mix(in srgb, ${props.surfaceColor} 92%, black)`
      : 'var(--sidebar-surface-hover)',
    '--sidebar-dialog-surface': props.surfaceColor || 'var(--sidebar-dialog-surface-default)',
  } as CSSProperties;

  const handleDragEnd = async (event: DragEndEvent) => {
    const active = event.active.data.current as DragItem | undefined;
    const target = event.over?.data.current as DropTarget | undefined;
    setDropIndicator(null);
    if (active && target) {
      animateNextLayout.current = true;
      await props.onDragEnd(active, target);
    }
    setActiveDrag(null);
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveDrag((event.active.data.current as DragItem | undefined) || null);
  };

  const handleDragOver = (event: DragOverEvent) => {
    const over = event.over;
    if (!over || String(over.id).startsWith('folder-inside:')) {
      setDropIndicator(null);
      return;
    }
    const target = over.data.current as DropTarget | undefined;
    const rect = over.rect;
    if (!target) {
      setDropIndicator(null);
      return;
    }
    if (target.area === 'favorite') {
      setDropIndicator({
        left: rect.left + rect.width / 2 - 1,
        top: rect.top + 4,
        width: 2,
        height: Math.max(0, rect.height - 8),
      });
      return;
    }
    setDropIndicator({
      left: rect.left,
      top: rect.top + rect.height / 2 - 1,
      width: rect.width,
      height: 2,
    });
  };

  const handleDragCancel = (_event: DragCancelEvent) => {
    setDropIndicator(null);
    setActiveDrag(null);
  };

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
      onDragOver={handleDragOver}
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
              archiveOpen={props.archiveOpen}
              archivedTabs={props.archivedTabs}
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
        {props.folderPendingDeletion ? (
          <ConfirmDialog
            title="Delete folder?"
            message={`Delete "${props.folderPendingDeletion.title}" and remove its pinned items? Open tabs will remain open.`}
            confirmLabel="Delete Folder"
            onCancel={props.onCancelFolderDeletion}
            onConfirm={props.onConfirmFolderDeletion}
          />
        ) : null}
      </div>
      {dropIndicator ? (
        <div className="shared-drop-indicator" style={dropIndicator} />
      ) : null}
      <DragOverlay dropAnimation={null}>{dragPreview}</DragOverlay>
    </DndContext>
  );
}
