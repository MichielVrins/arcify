import { CSS } from '@dnd-kit/utilities';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { FOLDER_CLOSED_DOTS_ICON, FOLDER_CLOSED_ICON, FOLDER_OPEN_ICON } from '../../icons.js';
import {
  ContextMenu as ShadcnContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from './context-menu';
import type {
  ArchivedTab,
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
  onRequestRename(row: TabRowViewModel): void;
  onDuplicate(row: TabRowViewModel): void;
  onToggleFavorite(row: TabRowViewModel): void;
  onTogglePinned(row: TabRowViewModel): void;
  onReplaceUrl(row: TabRowViewModel): void;
  onCloseBelow(row: TabRowViewModel): void;
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
  onRequestFolderRename(folderId: string): void;
  onRequestSubfolder(folderId: string): void;
  onRequestFolderDeletion(folderId: string): void;
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

function useAnimatedItems<T>(
  items: T[],
  keyOf: (item: T) => string,
): Array<{ item: T; entering: boolean; exiting: boolean }> {
  const [rendered, setRendered] = useState(items);
  const [enteringKeys, setEnteringKeys] = useState<Set<string>>(new Set());
  const [exitingKeys, setExitingKeys] = useState<Set<string>>(new Set());
  const latestItems = useRef(items);
  const renderedItems = useRef(rendered);
  latestItems.current = items;
  renderedItems.current = rendered;
  const itemKeys = new Set(items.map(keyOf));
  const renderedKeys = new Set(rendered.map(keyOf));
  const isPureReorder =
    itemKeys.size === renderedKeys.size &&
    [...itemKeys].every(key => renderedKeys.has(key));

  useLayoutEffect(() => {
    const previous = renderedItems.current;
    const previousKeys = new Set(previous.map(keyOf));
    const nextKeys = new Set(items.map(keyOf));
    const removed = previous.filter(item => !nextKeys.has(keyOf(item)));
    const addedKeys = new Set(
      items.filter(item => !previousKeys.has(keyOf(item))).map(keyOf),
    );
    if (removed.length === 0) {
      if (addedKeys.size > 0) {
        setEnteringKeys(current => new Set([...current, ...addedKeys]));
        window.setTimeout(() => {
          setEnteringKeys(current => {
            const next = new Set(current);
            for (const key of addedKeys) next.delete(key);
            return next;
          });
        }, 150);
      }
      setRendered(items);
      return;
    }

    const removedKeys = new Set(removed.map(keyOf));
    setExitingKeys(current => new Set([...current, ...removedKeys]));
    const merged = [...items];
    for (const item of removed) {
      const previousIndex = previous.findIndex(
        candidate => keyOf(candidate) === keyOf(item),
      );
      merged.splice(Math.min(previousIndex, merged.length), 0, item);
    }
    setRendered(merged);
    window.setTimeout(() => {
      const liveKeys = new Set(latestItems.current.map(keyOf));
      setRendered(current =>
        current.filter(item => !removedKeys.has(keyOf(item)) || liveKeys.has(keyOf(item))),
      );
      setExitingKeys(current => {
        const next = new Set(current);
        for (const key of removedKeys) next.delete(key);
        return next;
      });
    }, 150);
  }, [items, keyOf]);

  const visibleItems = isPureReorder ? items : rendered;
  return visibleItems.map(item => ({
    item,
    entering: enteringKeys.has(keyOf(item)),
    exiting: exitingKeys.has(keyOf(item)),
  }));
}

const pinnedLinkKey = (item: PinnedLink) => item.id;
const tabRowKey = (row: TabRowViewModel) => row.key;

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
}

function Draggable({
  id,
  dragItem,
  children,
  className = '',
}: DraggableProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    isDragging,
  } = useDraggable({
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
      data-reorder-key={id}
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
  entering?: boolean;
  exiting?: boolean;
}

function TabContextMenuContent({
  row,
  actions,
}: {
  row: TabRowViewModel;
  actions: TabActions;
}) {
  return (
    <ContextMenuContent>
      <ContextMenuItem onSelect={() => actions.onRequestRename(row)}>
        Rename
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => actions.onDuplicate(row)}>
        Duplicate Tab
      </ContextMenuItem>
      <ContextMenuSeparator />
      {row.pinned ? (
        <ContextMenuItem onSelect={() => actions.onToggleFavorite(row)}>
          {row.favorite ? 'Remove from Favorites' : 'Add to Favorites'}
        </ContextMenuItem>
      ) : null}
      <ContextMenuItem onSelect={() => actions.onTogglePinned(row)}>
        {row.pinned ? 'Unpin Tab' : 'Pin Tab'}
      </ContextMenuItem>
      {row.pinned && row.open ? (
        <ContextMenuItem onSelect={() => actions.onReplaceUrl(row)}>
          Replace Pinned URL
        </ContextMenuItem>
      ) : null}
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => actions.onClose(row)}>
        {row.open ? 'Close Tab' : 'Remove Pinned Tab'}
      </ContextMenuItem>
      {!row.pinned ? (
        <ContextMenuItem onSelect={() => actions.onCloseBelow(row)}>
          Close Tabs Below
        </ContextMenuItem>
      ) : null}
    </ContextMenuContent>
  );
}

export function TabRow({
  row,
  dragItem,
  actions,
  entering = false,
  exiting = false,
}: TabRowProps) {
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
      className={`react-tab-row ${entering ? 'entering' : ''} ${actions.closingKeys.has(row.key) || exiting ? 'closing' : ''}`}
    >
      <ShadcnContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={rowRef}
            className={`tab ${row.active ? 'active' : ''} ${row.open ? '' : 'inactive bookmark-only'}`}
            onClick={() => actions.onActivate(row)}
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
        </ContextMenuTrigger>
        <TabContextMenuContent row={row} actions={actions} />
      </ShadcnContextMenu>
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
            >
              {actions.renamingKey === `item:${item.id}` ? (
                <InlineRename
                  renameKey={`item:${item.id}`}
                  initialTitle={row.title}
                  actions={actions}
                  className="favorite-title-input"
                />
              ) : (
                <ShadcnContextMenu>
                  <ContextMenuTrigger asChild>
                    <button
                      className={`pinned-favicon ${row.active ? 'active' : ''}`}
                      title={row.title}
                      onMouseDown={event => event.preventDefault()}
                      onClick={() => actions.onActivate(row)}
                    >
                      <img src={row.faviconUrl} alt={row.title} />
                    </button>
                  </ContextMenuTrigger>
                  <TabContextMenuContent row={row} actions={actions} />
                </ShadcnContextMenu>
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
    <ShadcnContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setNodeRef}
          className={`folder-header ${isOver ? 'folder-drop-active' : ''}`}
          onClick={() => actions.onToggleFolder(folder.id)}
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
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => actions.onRequestFolderRename(folder.id)}>
          Rename
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.onRequestSubfolder(folder.id)}>
          New Folder
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          className="danger"
          onSelect={() => actions.onRequestFolderDeletion(folder.id)}
        >
          Delete Folder
        </ContextMenuItem>
      </ContextMenuContent>
    </ShadcnContextMenu>
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
  const visibleOpenLinks = useMemo(
    () => expanded ? [] : openLinks(folder.children, rowByItemId),
    [expanded, folder.children, rowByItemId],
  );
  const animatedOpenLinks = useAnimatedItems(visibleOpenLinks, pinnedLinkKey);
  return (
    <div className={`folder ${expanded ? '' : 'collapsed'}`}>
      <DropZone
        id={`folder-before:${folder.id}`}
        target={{ area: 'pinned', parentId, index }}
      />
      <Draggable
        id={`folder:${folder.id}`}
        dragItem={{ kind: 'pinned', itemId: folder.id }}
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
      {!expanded && animatedOpenLinks.length > 0 ? (
        <div className="folder-collapsed-tabs">
          {animatedOpenLinks.map(({ item, entering, exiting }) => (
            <TabRow
              key={item.id}
              row={rowByItemId[item.id]}
              dragItem={{ kind: 'pinned', itemId: item.id }}
              actions={actions}
              entering={entering}
              exiting={exiting}
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
  const animatedTabs = useAnimatedItems(tabs, tabRowKey);
  return (
    <div className="temporary-tabs">
      <div className="temp-header">
        <div className="divider-line" />
        <button className="clean-tabs-btn" onClick={onCleanAll}>Clean All</button>
      </div>
      <div className="tabs-container" data-tab-type="temporary">
        {animatedTabs.map(({ item: row, entering, exiting }) => {
          const index = tabs.findIndex(candidate => candidate.key === row.key);
          return (
            <div className="react-tree-node" key={row.tabId}>
              {!exiting ? (
                <DropZone
                  id={`temporary-before:${row.tabId}`}
                  target={{ area: 'temporary', index }}
                />
              ) : null}
              <TabRow
                row={row}
                dragItem={{ kind: 'temporary', tabId: row.tabId as number }}
                actions={actions}
                entering={entering}
                exiting={exiting}
              />
            </div>
          );
        })}
        <DropZone
          id="temporary-end"
          target={{ area: 'temporary', index: tabs.length }}
        />
      </div>
    </div>
  );
}

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  onCancel(): void;
  onConfirm(): void;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div className="confirm-dialog-backdrop" role="presentation" onMouseDown={onCancel}>
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-message"
        onMouseDown={event => event.stopPropagation()}
      >
        <h2 id="confirm-dialog-title">{title}</h2>
        <p id="confirm-dialog-message">{message}</p>
        <div className="confirm-dialog-actions">
          <button ref={cancelRef} type="button" onClick={onCancel}>Cancel</button>
          <button type="button" className="danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

interface SidebarFooterProps {
  archiveOpen: boolean;
  archivedTabs: ArchivedTab[];
  onToggleArchive(): void;
  onRestore(tab: ArchivedTab): void;
  onNewFolder(): void;
  onOpenSettings(): void;
}

export function SidebarFooter({
  archiveOpen,
  archivedTabs,
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
          <button onClick={onToggleArchive}>Archived Tabs</button>
          <button onClick={onNewFolder}>New Folder</button>
          <div className="options-separator" />
          <button onClick={onOpenSettings}>Settings</button>
        </div>
      </div>
    </div>
  );
}
