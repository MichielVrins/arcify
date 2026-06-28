import { CSS } from '@dnd-kit/utilities';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { FOLDER_CLOSED_DOTS_ICON, FOLDER_CLOSED_ICON, FOLDER_OPEN_ICON } from '../../icons.js';
import type {
  ArchivedTab,
  ContextMenuState,
  DragItem,
  DropTarget,
  PinnedFolder,
  PinnedItem,
  PinnedLink,
  TabRowViewModel,
} from './types';

export interface TabActions {
  renamingKey: string | null;
  closingKeys: ReadonlySet<string>;
  onActivate(row: TabRowViewModel): void;
  onClose(row: TabRowViewModel): void;
  onContextMenu(row: TabRowViewModel, x: number, y: number): void;
  onRenameCommit(key: string, title: string): void;
  onRenameCancel(): void;
}

interface InlineRenameProps {
  renameKey: string;
  initialTitle: string;
  actions: TabActions;
  className: string;
}

function InlineRename({
  renameKey,
  initialTitle,
  actions,
  className,
}: InlineRenameProps) {
  const [draft, setDraft] = useState(initialTitle);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const commit = () => {
    const title = draft.trim();
    if (title && title !== initialTitle) {
      actions.onRenameCommit(renameKey, title);
    } else {
      actions.onRenameCancel();
    }
  };

  return (
    <input
      ref={inputRef}
      className={className}
      value={draft}
      aria-label="Rename"
      onChange={event => setDraft(event.target.value)}
      onBlur={commit}
      onClick={event => event.stopPropagation()}
      onPointerDown={event => event.stopPropagation()}
      onKeyDown={event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          actions.onRenameCancel();
        }
      }}
    />
  );
}

function NewFolderDraft({
  parentId,
  actions,
}: {
  parentId: string | null;
  actions: TabActions;
}) {
  const renameKey = `new-folder:${parentId || 'root'}`;
  if (actions.renamingKey !== renameKey) return null;
  return (
    <div className="folder folder-draft">
      <div className="folder-header">
        <div
          className="folder-icon"
          dangerouslySetInnerHTML={{ __html: FOLDER_CLOSED_ICON }}
        />
        <InlineRename
          renameKey={renameKey}
          initialTitle=""
          actions={actions}
          className="folder-title-input"
        />
      </div>
    </div>
  );
}

export interface PinnedTreeActions extends TabActions {
  onToggleFolder(folderId: string): void;
  onFolderContextMenu(folderId: string, x: number, y: number): void;
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function containsOpenTab(
  items: PinnedItem[],
  rowByItemId: Record<string, TabRowViewModel>,
): boolean {
  return items.some(item =>
    item.type === 'link'
      ? Boolean(rowByItemId[item.id]?.open)
      : containsOpenTab(item.children, rowByItemId),
  );
}

function openLinks(
  items: PinnedItem[],
  rowByItemId: Record<string, TabRowViewModel>,
): PinnedLink[] {
  return items.flatMap(item => {
    if (item.type === 'folder') return openLinks(item.children, rowByItemId);
    return rowByItemId[item.id]?.open ? [item] : [];
  });
}

interface DropZoneProps {
  id: string;
  target: DropTarget;
  horizontal?: boolean;
}

export function DropZone({ id, target, horizontal = false }: DropZoneProps) {
  const { setNodeRef } = useDroppable({ id, data: target });
  return (
    <div
      ref={setNodeRef}
      className={horizontal ? 'react-drop-zone-horizontal' : 'react-drop-zone'}
      aria-hidden="true"
    />
  );
}

interface DraggableProps {
  id: string;
  dragItem: DragItem;
  children: ReactNode;
  className?: string;
  layoutKey?: string;
}

function Draggable({
  id,
  dragItem,
  children,
  className = '',
  layoutKey,
}: DraggableProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id,
    data: dragItem,
  });
  const style: CSSProperties = {
    transform: isDragging ? undefined : CSS.Translate.toString(transform),
    opacity: isDragging ? 0.72 : undefined,
    position: 'relative',
    zIndex: isDragging ? 20 : undefined,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={className}
      data-layout-key={layoutKey}
      {...listeners}
      {...attributes}
      tabIndex={undefined}
    >
      {children}
    </div>
  );
}

interface TabRowProps {
  row: TabRowViewModel;
  dragItem: DragItem;
  actions: TabActions;
}

export function TabRow({ row, dragItem, actions }: TabRowProps) {
  const renameKey = row.itemId ? `item:${row.itemId}` : `tab:${row.tabId}`;
  const renaming = actions.renamingKey === renameKey;
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!row.active) return;
    rowRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [row.active]);

  return (
    <Draggable
      id={`tab:${row.key}`}
      dragItem={dragItem}
      className={`react-tab-row ${actions.closingKeys.has(row.key) ? 'closing' : ''}`}
      layoutKey={`tab:${row.key}`}
    >
      <div
        ref={rowRef}
        className={`tab ${row.active ? 'active' : ''} ${row.open ? '' : 'inactive bookmark-only'}`}
        onClick={() => actions.onActivate(row)}
        onContextMenu={event => {
          event.preventDefault();
          event.stopPropagation();
          actions.onContextMenu(row, event.clientX, event.clientY);
        }}
      >
        <div className="tab-surface">
          <img className="tab-favicon" src={row.faviconUrl} alt="" />
          {row.navigatedAway ? <span className="tab-url-changed-slash visible">/</span> : null}
          <div className="tab-details">
            {renaming ? (
              <InlineRename
                renameKey={renameKey}
                initialTitle={row.title}
                actions={actions}
                className="tab-title-input"
              />
            ) : (
              <span className="tab-title-display">{row.title}</span>
            )}
            {row.navigatedAway ? (
              <span className="tab-domain-display">
                {hostname(row.url)}
              </span>
            ) : null}
          </div>
          <button
            className={row.open ? 'tab-close' : 'tab-remove'}
            title={row.open ? 'Close Tab' : 'Remove Pinned Tab'}
            onClick={event => {
              event.stopPropagation();
              actions.onClose(row);
            }}
          >
            {row.open ? (row.pinned ? '−' : '×') : '×'}
          </button>
        </div>
      </div>
    </Draggable>
  );
}

interface FavoritesBarProps {
  favorites: Array<{ item: PinnedLink; row: TabRowViewModel }>;
  actions: TabActions;
}

export function FavoritesBar({ favorites, actions }: FavoritesBarProps) {
  return (
    <div className="pinned-favicons" id="pinnedFavicons">
      {favorites.map(({ item, row }, index) => (
        <div className="react-favorite-slot" key={item.id}>
          <DropZone
            id={`favorite-before:${item.id}`}
            target={{ area: 'favorite', index }}
            horizontal
          />
          <Draggable
            id={`favorite:${item.id}`}
            dragItem={{ kind: 'pinned', itemId: item.id }}
            className="react-favorite-drag"
            layoutKey={`tab:${item.id}`}
          >
            {actions.renamingKey === `item:${item.id}` ? (
              <InlineRename
                renameKey={`item:${item.id}`}
                initialTitle={row.title}
                actions={actions}
                className="favorite-title-input"
              />
            ) : (
              <button
                className={`pinned-favicon ${row.active ? 'active' : ''}`}
              title={row.title}
              onMouseDown={event => event.preventDefault()}
              onClick={() => actions.onActivate(row)}
                onContextMenu={event => {
                  event.preventDefault();
                  actions.onContextMenu(row, event.clientX, event.clientY);
                }}
              >
                <img src={row.faviconUrl} alt={row.title} />
              </button>
            )}
          </Draggable>
        </div>
      ))}
      <DropZone
        id="favorite-end"
        target={{ area: 'favorite', index: favorites.length }}
        horizontal
      />
      {favorites.length === 0 ? (
        <div className="pinned-placeholder-container">
          <div className="pinned-tab-placeholder" aria-label="Drop to add favorite" />
        </div>
      ) : null}
    </div>
  );
}

interface PinnedNodeProps {
  item: PinnedItem;
  index: number;
  parentId: string | null;
  expandedFolderIds: Set<string>;
  rowByItemId: Record<string, TabRowViewModel>;
  actions: PinnedTreeActions;
}

function PinnedNode({
  item,
  index,
  parentId,
  expandedFolderIds,
  rowByItemId,
  actions,
}: PinnedNodeProps) {
  if (item.type === 'link') {
    const row = rowByItemId[item.id];
    return (
      <div className="react-tree-node">
        <DropZone
          id={`pinned-before:${parentId || 'root'}:${item.id}`}
          target={{ area: 'pinned', parentId, index }}
        />
        <TabRow
          row={row}
          dragItem={{ kind: 'pinned', itemId: item.id }}
          actions={actions}
        />
      </div>
    );
  }

  return (
    <FolderNode
      folder={item}
      index={index}
      parentId={parentId}
      expandedFolderIds={expandedFolderIds}
      rowByItemId={rowByItemId}
      actions={actions}
    />
  );
}

interface FolderNodeProps {
  folder: PinnedFolder;
  index: number;
  parentId: string | null;
  expandedFolderIds: Set<string>;
  rowByItemId: Record<string, TabRowViewModel>;
  actions: PinnedTreeActions;
}

function FolderHeader({
  folder,
  expanded,
  hasOpenTabs,
  actions,
}: {
  folder: PinnedFolder;
  expanded: boolean;
  hasOpenTabs: boolean;
  actions: PinnedTreeActions;
}) {
  const { isOver, setNodeRef } = useDroppable({
    id: `folder-inside:${folder.id}`,
    data: {
      area: 'pinned',
      parentId: folder.id,
      index: folder.children.length,
    } satisfies DropTarget,
  });

  return (
    <div
      ref={setNodeRef}
      className={`folder-header ${isOver ? 'folder-drop-active' : ''}`}
      onClick={() => actions.onToggleFolder(folder.id)}
      onContextMenu={event => {
        event.preventDefault();
        event.stopPropagation();
        actions.onFolderContextMenu(folder.id, event.clientX, event.clientY);
      }}
    >
      <div
        className="folder-icon"
        dangerouslySetInnerHTML={{
          __html: expanded
            ? FOLDER_OPEN_ICON
            : hasOpenTabs
              ? FOLDER_CLOSED_DOTS_ICON
              : FOLDER_CLOSED_ICON,
        }}
      />
      {actions.renamingKey === `item:${folder.id}` ? (
        <InlineRename
          renameKey={`item:${folder.id}`}
          initialTitle={folder.title}
          actions={actions}
          className="folder-title-input"
        />
      ) : (
        <span className="folder-title">{folder.title}</span>
      )}
      <button className={`folder-toggle ${expanded ? '' : 'collapsed'}`} />
    </div>
  );
}

export function FolderNode({
  folder,
  index,
  parentId,
  expandedFolderIds,
  rowByItemId,
  actions,
}: FolderNodeProps) {
  const expanded = expandedFolderIds.has(folder.id);
  const hasOpenTabs = containsOpenTab(folder.children, rowByItemId);
  const visibleOpenLinks = expanded ? [] : openLinks(folder.children, rowByItemId);
  return (
    <div className={`folder ${expanded ? '' : 'collapsed'}`}>
      <DropZone
        id={`folder-before:${folder.id}`}
        target={{ area: 'pinned', parentId, index }}
      />
      <Draggable
        id={`folder:${folder.id}`}
        dragItem={{ kind: 'pinned', itemId: folder.id }}
        layoutKey={`folder:${folder.id}`}
      >
        <FolderHeader
          folder={folder}
          expanded={expanded}
          hasOpenTabs={hasOpenTabs}
          actions={actions}
        />
      </Draggable>
      {expanded ? (
        <div className="folder-content">
          {folder.children.map((child, childIndex) => (
            <PinnedNode
              key={child.id}
              item={child}
              index={childIndex}
              parentId={folder.id}
              expandedFolderIds={expandedFolderIds}
              rowByItemId={rowByItemId}
              actions={actions}
            />
          ))}
          {folder.children.length === 0 ? (
            <div className="tab-placeholder">Drag a tab here to add</div>
          ) : null}
          <DropZone
            id={`folder-end:${folder.id}`}
            target={{
              area: 'pinned',
              parentId: folder.id,
              index: folder.children.length,
            }}
          />
          <NewFolderDraft parentId={folder.id} actions={actions} />
        </div>
      ) : null}
      {!expanded && visibleOpenLinks.length > 0 ? (
        <div className="folder-collapsed-tabs">
          {visibleOpenLinks.map(item => (
            <TabRow
              key={item.id}
              row={rowByItemId[item.id]}
              dragItem={{ kind: 'pinned', itemId: item.id }}
              actions={actions}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface PinnedTreeProps {
  items: PinnedItem[];
  expandedFolderIds: Set<string>;
  rowByItemId: Record<string, TabRowViewModel>;
  actions: PinnedTreeActions;
}

export function PinnedTree({
  items,
  expandedFolderIds,
  rowByItemId,
  actions,
}: PinnedTreeProps) {
  return (
    <div className="tabs-container" data-tab-type="pinned">
      {items.map((item, index) => (
        <PinnedNode
          key={item.id}
          item={item}
          index={index}
          parentId={null}
          expandedFolderIds={expandedFolderIds}
          rowByItemId={rowByItemId}
          actions={actions}
        />
      ))}
      <DropZone
        id="pinned-root-end"
        target={{ area: 'pinned', parentId: null, index: items.length }}
      />
      <NewFolderDraft parentId={null} actions={actions} />
      {items.length === 0 ? (
        <div className="tab-placeholder">Drag a tab here to pin</div>
      ) : null}
    </div>
  );
}

interface TemporaryTabsProps {
  tabs: TabRowViewModel[];
  actions: TabActions;
  onCleanAll(): void;
}

export function TemporaryTabs({ tabs, actions, onCleanAll }: TemporaryTabsProps) {
  return (
    <div className="temporary-tabs">
      <div className="temp-header">
        <div className="divider-line" />
        <button className="clean-tabs-btn" onClick={onCleanAll}>Clean All</button>
      </div>
      <div className="tabs-container" data-tab-type="temporary">
        {tabs.map((row, index) => (
          <div className="react-tree-node" key={row.tabId}>
            <DropZone
              id={`temporary-before:${row.tabId}`}
              target={{ area: 'temporary', index }}
            />
            <TabRow
              row={row}
              dragItem={{ kind: 'temporary', tabId: row.tabId as number }}
              actions={actions}
            />
          </div>
        ))}
        <DropZone
          id="temporary-end"
          target={{ area: 'temporary', index: tabs.length }}
        />
      </div>
    </div>
  );
}

interface ContextMenuProps {
  menu: ContextMenuState;
  onClose(): void;
  onRename(): void;
  onCloseTab(): void;
  onCloseTabsBelow(): void;
  onToggleFavorite(): void;
  onTogglePinned(): void;
  onReplaceUrl(): void;
  onNewFolder(): void;
  onDeleteFolder(): void;
}

export function ContextMenu({
  menu,
  onClose,
  onRename,
  onCloseTab,
  onCloseTabsBelow,
  onToggleFavorite,
  onTogglePinned,
  onReplaceUrl,
  onNewFolder,
  onDeleteFolder,
}: ContextMenuProps) {
  if (!menu) return null;
  const item = (label: string, action: () => void) => (
    <button
      className="context-menu-item"
      onClick={() => {
        action();
        onClose();
      }}
    >
      {label}
    </button>
  );
  return (
    <>
      <div className="context-menu-backdrop" onClick={onClose} />
      <div className="context-menu react-context-menu" style={{ left: menu.x, top: menu.y }}>
        {item('Rename', onRename)}
        {menu.kind === 'folder' ? (
          <>
            {item('New Folder', onNewFolder)}
            {item('Delete Folder', onDeleteFolder)}
          </>
        ) : (
          <>
            {menu.row.pinned ? item(
              menu.row.favorite ? 'Remove from Favorites' : 'Add to Favorites',
              onToggleFavorite,
            ) : null}
            {item(menu.row.pinned ? 'Unpin Tab' : 'Pin Tab', onTogglePinned)}
            {menu.row.pinned && menu.row.open ? item('Replace Pinned URL', onReplaceUrl) : null}
            {item(menu.row.open ? 'Close Tab' : 'Remove Pinned Tab', onCloseTab)}
            {!menu.row.pinned ? item('Close Tabs Below', onCloseTabsBelow) : null}
          </>
        )}
      </div>
    </>
  );
}

interface SidebarFooterProps {
  color: string;
  archiveOpen: boolean;
  archivedTabs: ArchivedTab[];
  onColorChange(color: string): void;
  onToggleArchive(): void;
  onRestore(tab: ArchivedTab): void;
  onNewFolder(): void;
  onOpenSettings(): void;
}

export function SidebarFooter({
  color,
  archiveOpen,
  archivedTabs,
  onColorChange,
  onToggleArchive,
  onRestore,
  onNewFolder,
  onOpenSettings,
}: SidebarFooterProps) {
  return (
    <div className="sidebar-footer">
      {archiveOpen ? (
        <div className="archived-tabs-popup visible">
          <h3>Archived</h3>
          <div className="archived-tabs-list">
            {archivedTabs.map(tab => (
              <button key={`${tab.url}:${tab.archivedAt}`} onClick={() => onRestore(tab)}>
                {tab.name}
              </button>
            ))}
          </div>
          {archivedTabs.length === 0 ? (
            <div className="no-archived-tabs-message">No archived tabs.</div>
          ) : null}
        </div>
      ) : null}
      <div className="sidebar-options-container collection-options-container footer-options-container">
        <button className="collection-options footer-options-toggle" title="Options">•••</button>
        <div className="sidebar-options-dropdown collection-options-dropdown">
          <select value={color} onChange={event => onColorChange(event.target.value)}>
            {['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan'].map(value => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
          <button onClick={onToggleArchive}>Archived Tabs</button>
          <button onClick={onNewFolder}>New Folder</button>
          <div className="options-separator" />
          <button onClick={onOpenSettings}>Settings</button>
        </div>
      </div>
    </div>
  );
}
