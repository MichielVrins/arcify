/**
 * Sidebar - Main extension UI and tab management
 *
 * Purpose: Implements Arc-like vertical tab organization in one persistent sidebar state
 * Key Functions: Tab organization, drag-and-drop, archived tabs, spotlight integration
 * Architecture: Side panel UI backed by one local state object and the Arcify bookmark root
 * 
 * Critical Notes:
 * - Primary user interface for tab management
 * - Real-time sync with Chrome tabs and bookmark-backed pinned state
 * - Handles drag-and-drop for tab reorganization
 * - Integrates with spotlight system for search functionality
 * - Manages archived tabs and auto-archive settings
 */

import { FOLDER_CLOSED_ICON, FOLDER_CLOSED_DOTS_ICON, FOLDER_OPEN_ICON } from './icons.js';
import { LocalStorage } from './localstorage.js';
import { Utils } from './utils.js';
import {
    setupDOMElements,
    activateTabInDOM,
    applySidebarColor,
    showTabContextMenu,
    showArchivedTabsPopup,
    showUrlCopyToast,
    getDragAfterElement,
    getPinnedContainer,
    getTempContainer,
    clearAllActiveStates,
    hideAllDropIndicators,
    showDropIndicator,
    getDropPosition,
} from './domManager.js';
import { BookmarkUtils } from './bookmark-utils.js';
import { Logger } from './logger.js';
import { MOUSE_BUTTON } from './constants.js';

// DOM Elements
const tabsView = document.getElementById('tabsView');
const sidebarTemplate = document.getElementById('sidebarTemplate');

// Global state
let sidebarState = null;
let isOpeningBookmark = false;
let currentWindow = null;
let showAllOpenTabsInCollapsedFolders = false; // default Arc behavior is false (active-only)
let activeChromeTabId = null;
const MAIN_SIDEBAR_ID = 'main';
// Arc-like behavior: track which tabs have been active in each collapsed folder.
// These tabs stay visible until user manually opens/closes the folder.
// WeakMap<HTMLElement (folder), Set<number (tabId)>>
const collapsedFolderShownTabs = new WeakMap();

function sidebarOwnsTab(tabOrId) {
    const tabId = typeof tabOrId === 'object' ? tabOrId?.id : tabOrId;
    return Boolean(
        sidebarState &&
        (sidebarState.pinnedTabIds.includes(tabId) || sidebarState.temporaryTabs.includes(tabId))
    );
}

function normalizeStoredState(storedState, fallbackName, fallbackColor) {
    return {
        id: MAIN_SIDEBAR_ID,
        uuid: storedState?.uuid || Utils.generateUUID(),
        name: storedState?.name || fallbackName,
        color: storedState?.color || fallbackColor,
        pinnedTabIds: Array.isArray(storedState?.pinnedTabIds) ? storedState.pinnedTabIds : [],
        temporaryTabs: Array.isArray(storedState?.temporaryTabs) ? storedState.temporaryTabs : [],
        lastTab: storedState?.lastTab ?? null
    };
}

async function getBookmarkRootFolder() {
    return LocalStorage.getOrCreateArcifyFolder();
}

async function getOpenBookmarkTabIds(collectionFolder, tabs) {
    if (!collectionFolder) {
        return [];
    }

    const bookmarks = await BookmarkUtils.getBookmarksFromFolderRecursive(collectionFolder.id);
    const pinnedStatesById = await Utils.getPinnedTabStates();
    const matchedTabIds = [];

    for (const bookmark of bookmarks) {
        const matchingTab = tabs.find(tab =>
            !tab.pinned &&
            !matchedTabIds.includes(tab.id) &&
            (
                pinnedStatesById?.[tab.id]?.bookmarkId === bookmark.id ||
                tab.url === bookmark.url ||
                Utils.getPinnedUrlKey(tab.url) === Utils.getPinnedUrlKey(bookmark.url)
            )
        );

        if (!matchingTab) {
            continue;
        }

        matchedTabIds.push(matchingTab.id);

        if (bookmark.title && bookmark.title !== matchingTab.title) {
            await Utils.setTabNameOverride(matchingTab.id, matchingTab.url, bookmark.title);
        }
    }

    return matchedTabIds;
}

async function initializeSidebarState(storedState, allTabs, bookmarkRootFolder) {
    const name = storedState?.name || 'Home';
    const color = storedState?.color || await Utils.getTabGroupColor(name);

    const currentTabs = Array.isArray(allTabs) ? allTabs : await chrome.tabs.query({ currentWindow: true });
    const pinnedTabIds = await getOpenBookmarkTabIds(bookmarkRootFolder, currentTabs);
    const temporaryTabs = currentTabs
        .filter(tab => !tab.pinned && !pinnedTabIds.includes(tab.id))
        .map(tab => tab.id);

    sidebarState = normalizeStoredState(storedState, name, color);
    sidebarState.id = MAIN_SIDEBAR_ID;
    sidebarState.name = name;
    sidebarState.color = color;
    sidebarState.pinnedTabIds = pinnedTabIds;
    sidebarState.temporaryTabs = temporaryTabs;
    sidebarState.lastTab = storedState?.lastTab ?? currentTabs.find(tab => tab.active && !tab.pinned)?.id ?? temporaryTabs[0] ?? pinnedTabIds[0] ?? null;

    renderSidebarView(sidebarState);
    saveSidebarState();
    reapplySidebarColors();
    await activateSidebar(false);
}

// Helper function to update bookmark for a tab
async function updateBookmarkForTab(tab, bookmarkTitle) {
    Logger.log("updating bookmark", tab, bookmarkTitle);
    const bookmarkRoot = await getBookmarkRootFolder();
    const pinnedState = await Utils.getPinnedTabState(tab.id);
    if (pinnedState?.bookmarkId) {
        try {
            await chrome.bookmarks.update(pinnedState.bookmarkId, { title: bookmarkTitle });
            return;
        } catch (e) {
            Logger.warn('[Bookmarks] Failed updating bookmark by stored bookmarkId, falling back to URL search.', e);
        }
    }

    const pinnedUrl = pinnedState?.pinnedUrl;
    if (!pinnedUrl) return;
    const bookmark = await BookmarkUtils.findBookmarkInFolderRecursive(bookmarkRoot.id, { url: pinnedUrl });
    if (bookmark?.bookmark?.id) {
        await chrome.bookmarks.update(bookmark.bookmark.id, { title: bookmarkTitle });
        await Utils.setPinnedTabState(tab.id, { bookmarkId: bookmark.bookmark.id, pinnedUrl: pinnedUrl });
    }

}

async function replaceBookmarkUrlWithCurrentUrl(tab, tabElement) {
    if (!tab?.id) return;

    // Always prefer the live tab URL (the `tab` object captured by the UI can be stale).
    let liveTab = null;
    try {
        liveTab = await chrome.tabs.get(tab.id);
    } catch (e) {
        // We'll fall back to dataset/tab url below.
    }

    const newUrl = liveTab?.url || tabElement?.dataset?.url || tab?.url || null;
    if (!newUrl) {
        console.warn('[Arcify] Replace bookmark URL failed: missing current tab URL', { tabId: tab.id });
        return;
    }
    const newTitle = liveTab?.title || tab?.title || null;

    const stored = await Utils.getPinnedTabState(tab.id);
    const bookmarkId = tabElement?.dataset?.bookmarkId || stored?.bookmarkId;
    const pinnedUrl = tabElement?.dataset?.pinnedUrl || stored?.pinnedUrl;

    // If we don't know the bookmarkId, try resolving by pinnedUrl within the Arcify bookmark tree.
    let resolvedBookmarkId = bookmarkId;
    if (!resolvedBookmarkId && pinnedUrl) {
        const bookmarkRoot = await getBookmarkRootFolder();
        const result = await BookmarkUtils.findBookmarkInFolderRecursive(bookmarkRoot.id, { url: pinnedUrl });
        resolvedBookmarkId = result?.bookmark?.id || null;
    }

    if (!resolvedBookmarkId) {
        console.warn('[Arcify] Cannot replace bookmark URL: missing bookmarkId and unable to resolve.', {
            tabId: tab.id,
            pinnedUrl,
            dataset: tabElement?.dataset
        });
        return;
    }

    try {
        const updatePayload = { url: newUrl };
        // Keep bookmark title in sync with the new pinned page for clarity.
        if (newTitle) updatePayload.title = newTitle;
        await chrome.bookmarks.update(resolvedBookmarkId, updatePayload);
    } catch (e) {
        console.error('[Arcify] chrome.bookmarks.update failed', { bookmarkId: resolvedBookmarkId, newUrl, error: e });
        return;
    }

    await Utils.setPinnedTabState(tab.id, { bookmarkId: resolvedBookmarkId, pinnedUrl: newUrl });
    if (newTitle) {
        // Update override baseline (and pinned display) to the new URL/title.
        await Utils.setTabNameOverride(tab.id, newUrl, newTitle);
    }

    if (tabElement) {
        tabElement.dataset.pinnedUrl = newUrl;
        tabElement.dataset.url = newUrl;
        // Tab is now pinned to current URL; "back to pinned" should no longer be available.
        const favicon = tabElement.querySelector('.tab-favicon') || tabElement.querySelector('img');
        if (favicon) {
            favicon.classList.remove('pinned-back');
            favicon.title = '';
        }
        const slash = tabElement.querySelector('.tab-url-changed-slash');
        if (slash) slash.classList.remove('visible');

        // Ensure the displayed title + domain subtitle reflect the new pinned URL immediately.
        const titleDisplay = tabElement.querySelector('.tab-title-display');
        if (titleDisplay && newTitle) titleDisplay.textContent = newTitle;
        const domainDisplay = tabElement.querySelector('.tab-domain-display');
        if (domainDisplay) domainDisplay.style.display = 'none';
    }
}

// Function to apply color overrides from settings
async function applyColorOverrides() {
    try {
        const settings = await Utils.getSettings();
        Logger.log('Applying color overrides, settings:', settings);

        const root = document.documentElement;

        // Clear any existing overrides first
        const colorNames = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan'];
        colorNames.forEach(colorName => {
            root.style.removeProperty(`--user-chrome-${colorName}-color`);
        });

        // Apply new overrides if they exist
        if (settings.colorOverrides && Object.keys(settings.colorOverrides).length > 0) {
            Logger.log('Found color overrides:', settings.colorOverrides);
            Object.keys(settings.colorOverrides).forEach(colorName => {
                const colorValue = settings.colorOverrides[colorName];
                if (colorValue) {
                    root.style.setProperty(`--user-chrome-${colorName}-color`, colorValue);
                    Logger.log(`Applied color override: --user-chrome-${colorName}-color = ${colorValue}`);
                }
            });
        } else {
            Logger.log('No color overrides found in settings');
        }

        reapplySidebarColors();
    } catch (error) {
        Logger.error('Error applying color overrides:', error);
    }
}

function reapplySidebarColors() {
    const sidebarContainer = document.getElementById('sidebar-container');
    if (!sidebarContainer || !sidebarState) return;

    const root = document.documentElement;
    const colorVar = `--chrome-${sidebarState.color}-color`;
    const colorDarkVar = `--chrome-${sidebarState.color}-color-dark`;

    // Get computed values
    const computedStyle = getComputedStyle(root);
    let colorValue = computedStyle.getPropertyValue(colorVar).trim();
    let colorDarkValue = computedStyle.getPropertyValue(colorDarkVar).trim();

    // Fallback if variables aren't set yet
    if (!colorValue) {
        colorValue = `var(--chrome-${sidebarState.color}-color, rgba(255, 255, 255, 0.1))`;
    }
    if (!colorDarkValue) {
        colorDarkValue = `var(--chrome-${sidebarState.color}-color-dark, rgba(255, 255, 255, 0.1))`;
    }

    sidebarContainer.style.setProperty('--sidebar-bg-color', colorValue);
    sidebarContainer.style.setProperty('--sidebar-bg-color-dark', colorDarkValue);
    sidebarContainer.style.setProperty('--collection-bg-color', colorValue);
    sidebarContainer.style.setProperty('--collection-bg-color-dark', colorDarkValue);
}

// Function to update pinned favicons
async function updatePinnedFavicons() {
    const pinnedFavicons = document.getElementById('pinnedFavicons');
    const pinnedTabs = await chrome.tabs.query({ pinned: true });

    // Remove favicon elements for tabs that are no longer pinned
    Array.from(pinnedFavicons.children).forEach(element => {
        // Only remove elements that are pinned favicons (have the pinned-favicon class)
        if (element.classList.contains('pinned-favicon')) {
            const tabId = element.dataset.tabId;
            if (!pinnedTabs.some(tab => tab.id.toString() === tabId)) {
                element.remove();
            }
        }
    });

    pinnedTabs.forEach(tab => {
        // Check if favicon element already exists for this tab
        const existingElement = pinnedFavicons.querySelector(`[data-tab-id="${tab.id}"]`);
        if (!existingElement) {
            const faviconElement = document.createElement('div');
            faviconElement.className = 'pinned-favicon';
            faviconElement.title = tab.title;
            faviconElement.dataset.tabId = tab.id;
            faviconElement.draggable = true; // Make pinned favicon draggable

            const img = document.createElement('img');
            img.src = Utils.getFaviconUrl(tab.url, "96");
            img.onerror = () => {
                img.src = tab.favIconUrl;
                img.onerror = () => { img.src = 'assets/default_icon.png'; }; // Fallback favicon
            };
            img.alt = tab.title;

            faviconElement.appendChild(img);
            faviconElement.addEventListener('mousedown', (event) => {
                if (event.button === MOUSE_BUTTON.LEFT) {
                    clearAllActiveStates();
                    // Add active class to clicked tab
                    faviconElement.classList.add('active');
                    chrome.tabs.update(tab.id, { active: true });
                }
            });

            // Add drag event listeners for pinned favicon
            faviconElement.addEventListener('dragstart', () => {
                faviconElement.classList.add('dragging');
            });

            faviconElement.addEventListener('dragend', () => {
                faviconElement.classList.remove('dragging');
            });

            pinnedFavicons.appendChild(faviconElement);
        }
    });

    // Show/hide placeholder based on whether there are pinned tabs
    const placeholderContainer = pinnedFavicons.querySelector('.pinned-placeholder-container');
    if (placeholderContainer) {
        if (pinnedTabs.length === 0) {
            placeholderContainer.style.display = 'block';
        } else {
            placeholderContainer.style.display = 'none';
        }
    }

    // Add drag and drop event listeners
    pinnedFavicons.addEventListener('dragover', e => {
        e.preventDefault();
        e.currentTarget.classList.add('drag-over');

        // Show drop indicator for horizontal favicons
        const draggingElement = document.querySelector('.dragging');
        if (draggingElement) {
            const afterElement = getDragAfterElementFavicon(pinnedFavicons, e.clientX);
            if (afterElement) {
                // Check if this is a placeholder (empty container)
                if (afterElement.classList.contains('pinned-placeholder-container')) {
                    // Show visual feedback on the placeholder itself
                    afterElement.classList.add('drag-over');
                    hideAllDropIndicators(); // Don't show traditional indicators for placeholders
                } else {
                    // Show traditional drop indicators for actual favicons
                    const position = getDropPosition(afterElement, e.clientX, e.clientY, true);
                    showDropIndicator(afterElement, position, true);
                    // Remove any placeholder drag-over state
                    const placeholder = pinnedFavicons.querySelector('.pinned-placeholder-container');
                    if (placeholder) placeholder.classList.remove('drag-over');
                }
            } else {
                hideAllDropIndicators();
                // Remove any placeholder drag-over state
                const placeholder = pinnedFavicons.querySelector('.pinned-placeholder-container');
                if (placeholder) placeholder.classList.remove('drag-over');
            }
        }
    });

    pinnedFavicons.addEventListener('dragleave', e => {
        e.preventDefault();
        e.currentTarget.classList.remove('drag-over');
        // Hide indicators when leaving the pinned favicons area
        if (!pinnedFavicons.contains(e.relatedTarget)) {
            hideAllDropIndicators();
            // Remove any placeholder drag-over state
            const placeholder = pinnedFavicons.querySelector('.pinned-placeholder-container');
            if (placeholder) placeholder.classList.remove('drag-over');
        }
    });

    pinnedFavicons.addEventListener('drop', async e => {
        e.preventDefault();
        e.currentTarget.classList.remove('drag-over');
        hideAllDropIndicators(); // Clean up indicators on drop
        // Remove any placeholder drag-over state
        const placeholder = pinnedFavicons.querySelector('.pinned-placeholder-container');
        if (placeholder) placeholder.classList.remove('drag-over');
        const draggingElement = document.querySelector('.dragging');
        if (draggingElement && draggingElement.dataset.tabId) {
            const tabId = parseInt(draggingElement.dataset.tabId);

            // If dragging a pinned favicon to reorder, handle positioning
            if (draggingElement.classList.contains('pinned-favicon')) {
                const afterElement = getDragAfterElementFavicon(pinnedFavicons, e.clientX);
                if (afterElement) {
                    // Check if this is a placeholder (empty container)
                    if (afterElement.classList.contains('pinned-placeholder-container')) {
                        // Empty container - append directly and hide placeholder
                        pinnedFavicons.appendChild(draggingElement);
                        afterElement.style.display = 'none';
                    } else {
                        // Normal positioning logic for actual favicons
                        const position = getDropPosition(afterElement, e.clientX, e.clientY, true);

                        // Position element based on indicator logic
                        if (position === 'left') {
                            pinnedFavicons.insertBefore(draggingElement, afterElement);
                        } else { // 'right'
                            const nextSibling = afterElement.nextElementSibling;
                            if (nextSibling) {
                                pinnedFavicons.insertBefore(draggingElement, nextSibling);
                            } else {
                                pinnedFavicons.appendChild(draggingElement);
                            }
                        }
                    }
                } else {
                    // Fallback: append to end
                    pinnedFavicons.appendChild(draggingElement);
                }
            } else {
                // Dragging a regular tab to make it pinned
                const afterElement = getDragAfterElementFavicon(pinnedFavicons, e.clientX);
                let position = null;
                let targetIndex = 0; // Default to index 0 for empty containers

                if (afterElement) {
                    if (afterElement.classList.contains('pinned-placeholder-container')) {
                        // Empty container - use index 0 and hide placeholder after pinning
                        targetIndex = 0;
                    } else {
                        // Normal positioning logic for actual favicons
                        position = getDropPosition(afterElement, e.clientX, e.clientY, true);
                        targetIndex = calculatePinnedTabIndex(afterElement, position, pinnedFavicons);
                    }
                }

                // Step 1: Pin the tab (this adds it to the end by default)
                await chrome.tabs.update(tabId, { pinned: true });

                // Step 2: Move it to the correct position if needed
                if (targetIndex !== undefined && targetIndex >= 0) {
                    try {
                        await chrome.tabs.move(tabId, { index: targetIndex });
                    } catch (error) {
                        Logger.warn('Error moving pinned tab to target index:', error);
                    }
                }

                // Step 3: Update the favicon display
                updatePinnedFavicons();

                // Hide placeholder if this was an empty container
                if (afterElement && afterElement.classList.contains('pinned-placeholder-container')) {
                    afterElement.style.display = 'none';
                }

                // Remove the tab from its original container
                draggingElement.remove();
            }
        }
    });
}

// Utility function to activate a pinned tab by URL (reuses existing bookmark opening logic)
async function activatePinnedTabByURL(bookmarkUrl) {
    Logger.log('[PinnedTabActivator] Activating pinned tab:', bookmarkUrl);

    try {
        // Try to find existing tab with this URL
        const tabs = await chrome.tabs.query({});
        const existingTab = BookmarkUtils.findTabByUrl(tabs, bookmarkUrl);

        if (existingTab) {
            Logger.log('[PinnedTabActivator] Found existing tab, switching to it:', existingTab.id);
            // Tab already exists, just switch to it and highlight
            chrome.tabs.update(existingTab.id, { active: true });
            activateTabInDOM(existingTab.id);

            if (sidebarOwnsTab(existingTab)) {
                sidebarState.lastTab = existingTab.id;
                saveSidebarState();
            }
        } else {
            Logger.log('[PinnedTabActivator] No existing tab found, opening bookmark');
            // Find existing bookmark-only element to replace
            const existingBookmarkElement = document.querySelector(`[data-url="${bookmarkUrl}"].bookmark-only`);

            // Find the bookmark to get the correct title
            const bookmarkRoot = await getBookmarkRootFolder();

            let bookmarkTitle = null;
            if (bookmarkRoot) {
                const bookmarks = await chrome.bookmarks.getChildren(bookmarkRoot.id);
                const matchingBookmark = BookmarkUtils.findBookmarkByUrl(bookmarks, bookmarkUrl);
                if (matchingBookmark) {
                    bookmarkTitle = matchingBookmark.title;
                }
            }

            // Prepare bookmark data for opening
            const bookmarkData = {
                url: bookmarkUrl,
                title: bookmarkTitle || 'Bookmark',
                sidebarName: sidebarState?.name,
                pinnedUrl: bookmarkUrl,
                bookmarkId: existingBookmarkElement?.dataset?.bookmarkId || null
            };

            const context = {
                sidebarState,
                currentWindow,
                saveSidebarState,
                createTabElement,
                activateTabInDOM,
                Utils
            };

            // Use shared bookmark opening logic
            isOpeningBookmark = true;
            try {
                await BookmarkUtils.openBookmarkAsTab(bookmarkData, existingBookmarkElement, context, /*isPinned=*/true);
            } finally {
                isOpeningBookmark = false;
            }
        }
    } catch (error) {
        Logger.error("[PinnedTabActivator] Error activating pinned tab:", error);
        isOpeningBookmark = false;
    }
}

function updateSpotlightButtonState(mode, isOpen) {
    const newTabBtn = document.getElementById('newTabBtn');
    if (!newTabBtn || mode !== 'new-tab') {
        return;
    }
    newTabBtn.classList.toggle('spotlight-active', isOpen);
}

async function pinSidebarTab(tabToToggle) {
    if (!tabToToggle) {
        Logger.error("[Pin] No tab found to pin.");
        return;
    }

    if (!sidebarState) {
        Logger.error("[Pin] Sidebar state not initialized.");
        return;
    }

    if (sidebarState.pinnedTabIds.includes(tabToToggle.id)) {
        Logger.log(`[Pin] Tab ${tabToToggle.id} is already pinned.`);
        return;
    }

    Logger.log(`[Pin] Pinning tab ${tabToToggle.id}.`);
    await moveTabInSidebar(tabToToggle.id, true);
    await moveTabToPinned(sidebarState, tabToToggle);
}

async function unpinSidebarTab(tabToToggle) {
    if (!tabToToggle) {
        Logger.error("[Pin] No tab found to unpin.");
        return;
    }

    if (!sidebarState) {
        Logger.error("[Pin] Sidebar state not initialized.");
        return;
    }

    if (!sidebarState.pinnedTabIds.includes(tabToToggle.id)) {
        Logger.log(`[Pin] Tab ${tabToToggle.id} is not pinned.`);
        return;
    }

    Logger.log(`[Pin] Unpinning tab ${tabToToggle.id}.`);
    await moveTabInSidebar(tabToToggle.id, false);
    await moveTabToTemp(sidebarState, tabToToggle);
}

async function toggleSidebarPinForTab(tabToToggle) {
    if (!tabToToggle) {
        Logger.error("[QuickPin] No tab found to toggle.");
        return;
    }

    if (!sidebarState) {
        Logger.error("[QuickPin] Sidebar state not initialized.");
        return;
    }

    if (sidebarState.temporaryTabs.includes(tabToToggle.id)) {
        Logger.log(`[QuickPin] Tab ${tabToToggle.id} is a temporary tab. Pinning it.`);
        await pinSidebarTab(tabToToggle);
        return;
    }

    if (sidebarState.pinnedTabIds.includes(tabToToggle.id)) {
        Logger.log(`[QuickPin] Tab ${tabToToggle.id} is a pinned tab. Unpinning it.`);
        await unpinSidebarTab(tabToToggle);
        return;
    }

    Logger.warn(`[QuickPin] Tab ${tabToToggle.id} not found in the sidebar state.`);
}

function setupSidebarRuntimeListeners() {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.command === "quickPinToggle" || request.command === "pinTab" || request.command === "unpinTab") {
            Logger.log(`[Pin] Received command: ${request.command}`, { request });

            if (request.command === "quickPinToggle") {
                chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
                    await toggleSidebarPinForTab(tabs[0]);
                });
            } else if ((request.command === "pinTab" || request.command === "unpinTab") && request.tabId) {
                chrome.tabs.get(request.tabId, async (tab) => {
                    if (request.command === "pinTab") {
                        await pinSidebarTab(tab);
                    } else if (request.command === "unpinTab") {
                        await unpinSidebarTab(tab);
                    }
                });
            }
            return false;
        }

        if (request.command === "copyCurrentUrl") {
            Logger.log(`[URLCopy] Sidebar fallback - copying URL: ${request.url}`);

            if (navigator.clipboard && request.url) {
                navigator.clipboard.writeText(request.url).then(() => {
                    Logger.log(`[URLCopy] Sidebar fallback succeeded: ${request.url}`);
                    showUrlCopyToast();
                    sendResponse({ success: true });
                }).catch(err => {
                    Logger.error("[URLCopy] Sidebar fallback failed:", err);
                    sendResponse({ success: false, error: err.message });
                });
            } else {
                Logger.error("[URLCopy] Sidebar fallback failed: navigator.clipboard not available or no URL");
                sendResponse({ success: false, error: "Clipboard API not available" });
            }
            return true;
        }

        if (request.action === "urlCopySuccess") {
            Logger.log("[URLCopy] Received success message from background script");
            showUrlCopyToast();
            sendResponse({ success: true });
            return false;
        }

        if (request.action === "spotlightOpened") {
            Logger.log("[Spotlight] Spotlight opened with mode:", request.mode);
            updateSpotlightButtonState(request.mode, true);
            return false;
        }

        if (request.action === "spotlightClosed") {
            Logger.log("[Spotlight] Spotlight closed");
            updateSpotlightButtonState('new-tab', false);
            return false;
        }

        if (request.action === "activatePinnedTab") {
            Logger.log("[Spotlight] Activating pinned tab:", request);
            activatePinnedTabByURL(request.bookmarkUrl);
            return false;
        }

        return false;
    });
}

// Initialize the sidebar when the DOM is loaded
document.addEventListener('DOMContentLoaded', async () => {
    Logger.log('DOM loaded, initializing sidebar...');
    await applyColorOverrides();

    // Listen for storage changes to re-apply colors when they're updated
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'sync' && changes.colorOverrides) {
            Logger.log('Color overrides changed, re-applying...');
            applyColorOverrides();
        }

        // Re-render the sidebar when tab order inversion setting changes
        if (areaName === 'sync' && changes.invertTabOrder) {
            Logger.log('invertTabOrder changed, refreshing sidebar UI...');
            if (refreshSidebarUITimeout) clearTimeout(refreshSidebarUITimeout);
            refreshSidebarUITimeout = setTimeout(() => {
                refreshSidebarUITimeout = null;
                refreshSidebarUI();
            }, 50);
        }

        if (areaName === 'sync' && changes.showAllOpenTabsInCollapsedFolders) {
            showAllOpenTabsInCollapsedFolders = Boolean(changes.showAllOpenTabsInCollapsedFolders.newValue);
            syncCollapsedFolders();
        }
    });

    initSidebar();
    updatePinnedFavicons(); // Initial load of pinned favicons

    // Add Chrome tab event listeners
    chrome.tabs.onCreated.addListener(handleTabCreated);
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        handleTabUpdate(tabId, changeInfo, tab);
        if (tab.pinned) updatePinnedFavicons(); // Update favicons when a tab is pinned/unpinned
    });
    chrome.tabs.onRemoved.addListener(handleTabRemove);
    chrome.tabs.onMoved.addListener(handleTabMove);
    chrome.tabs.onActivated.addListener(handleTabActivated);
    setupSidebarRuntimeListeners();

    // Tab navigation listener
    // Add event listener for placeholder close button
    const closePlaceholderBtn = document.querySelector('.placeholder-close-btn');
    const placeholderContainer = document.querySelector('.pinned-placeholder-container');
    if (closePlaceholderBtn && placeholderContainer) {
        closePlaceholderBtn.addEventListener('click', () => {
            placeholderContainer.style.display = 'none';
        });
    }

});

async function initSidebar() {
    Logger.log('Initializing sidebar...');
    let settings = await Utils.getSettings();
    showAllOpenTabsInCollapsedFolders = Boolean(settings.showAllOpenTabsInCollapsedFolders);
    try {
        currentWindow = await chrome.windows.getCurrent({ populate: false });
        // Seed current active tab for Arc-like collapsed folder behavior
        try {
            const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (activeTabs?.length) activeChromeTabId = activeTabs[0].id;
        } catch (e) {
            // ignore
        }

        let allTabs = await chrome.tabs.query({ currentWindow: true });
        Logger.log("allTabs", allTabs);

        // Check for duplicates
        await LocalStorage.mergeDuplicateBookmarkFolders();

        const bookmarkRoot = await getBookmarkRootFolder();
        Logger.log("bookmarkRoot", bookmarkRoot);
        const storedState = await Utils.getSidebarState();
        await initializeSidebarState(storedState, allTabs, bookmarkRoot);
    } catch (error) {
        Logger.error('Error initializing sidebar:', error);
    }

    setupDOMElements();
}

function renderSidebarView(state) {
    Logger.log('Creating sidebar view');
    const sidebarElement = sidebarTemplate.content.cloneNode(true);
    const sidebarView = sidebarElement.querySelector('.sidebar-view');

    const colorSelect = sidebarElement.getElementById('sidebarColorSelect');
    colorSelect.value = state.color;
    colorSelect.addEventListener('change', async () => {
        state.color = colorSelect.value;
        applySidebarColor(state.color);
        saveSidebarState();
    });

    const sidebarColorSwatch = sidebarElement.getElementById('sidebarColorSwatch');
    sidebarColorSwatch.addEventListener('click', (e) => {
        if (!e.target.classList.contains('color-swatch')) return;
        sidebarColorSwatch.querySelectorAll('.color-swatch').forEach(swatch => {
            swatch.classList.remove('selected');
        });
        e.target.classList.add('selected');
        colorSelect.value = e.target.dataset.color;
        colorSelect.dispatchEvent(new Event('change'));
    });

    const nameInput = sidebarElement.querySelector('.sidebar-name');
    nameInput.value = state.name;
    nameInput.addEventListener('change', async () => {
        state.name = nameInput.value;
        saveSidebarState();
    });

    const chevronButton = sidebarElement.querySelector('.sidebar-toggle-chevron');
    const pinnedSection = sidebarElement.querySelector('.pinned-tabs');
    const isPinnedCollapsed = localStorage.getItem('arcify-pinned-collapsed') === 'true';
    if (isPinnedCollapsed) {
        chevronButton.classList.add('collapsed');
        pinnedSection.classList.add('collapsed');
    }
    updateChevronState(sidebarElement, pinnedSection);

    chevronButton.addEventListener('click', (e) => {
        e.stopPropagation();
        const isCollapsed = chevronButton.classList.contains('collapsed');
        chevronButton.classList.toggle('collapsed', !isCollapsed);
        pinnedSection.classList.toggle('collapsed', !isCollapsed);
        localStorage.setItem('arcify-pinned-collapsed', (!isCollapsed).toString());
        updateChevronState(sidebarElement, pinnedSection);
    });

    const pinnedContainer = sidebarElement.querySelector('[data-tab-type="pinned"]');
    const tempContainer = sidebarElement.querySelector('[data-tab-type="temporary"]');
    const placeholderContainer = sidebarElement.querySelector('.placeholder-container');
    setupDragAndDrop(pinnedContainer, tempContainer);
    if (placeholderContainer) {
        setupPlaceholderDragAndDrop(placeholderContainer, pinnedContainer);
    }

    const cleanBtn = sidebarElement.querySelector('.clean-tabs-btn');
    cleanBtn.addEventListener('click', () => cleanTemporaryTabs());

    const newFolderBtn = sidebarElement.querySelector('.new-folder-btn');
    newFolderBtn.addEventListener('click', () => {
        createNewFolder(sidebarView);
    });

    const settingsBtn = sidebarElement.querySelector('.settings-btn');
    settingsBtn.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });

    loadTabs(state, pinnedContainer, tempContainer).then(() => {
        updatePinnedSectionPlaceholders();
    });

    const popup = sidebarElement.querySelector('.archived-tabs-popup');
    const archiveButton = sidebarElement.querySelector('.sidebar-button');
    const sidebarContent = sidebarElement.querySelector('.sidebar-content');
    archiveButton.addEventListener('click', (e) => {
        e.stopPropagation();
        sidebarContent.classList.toggle('hidden');
        const isVisible = popup.style.opacity == 1;
        if (isVisible) {
            popup.classList.toggle('visible');
        } else {
            showArchivedTabsPopup();
            popup.classList.toggle('visible');
        }
    });

    tabsView.appendChild(sidebarElement);

    const settingsButton = sidebarElement.querySelector('#sidebar-settings');
    if (settingsButton) {
        settingsButton.addEventListener('click', () => {
            if (chrome?.runtime?.openOptionsPage) {
                chrome.runtime.openOptionsPage();
            }
        });
    }
}

function getDragAfterElementTabs(container, y) {
    return getDragAfterElement(container, y, {
        axis: 'y',
        selector: '.tab:not(.dragging), .folder:not(.dragging)',
        placeholderSelector: '.tab-placeholder'
    });
}

function getDragAfterElementFavicon(container, x) {
    return getDragAfterElement(container, x, {
        axis: 'x',
        selector: '.pinned-favicon:not(.dragging)',
        placeholderSelector: '.pinned-placeholder-container'
    });
}

function calculatePinnedTabIndex(afterElement, position, pinnedFavicons) {
    if (!afterElement) {
        // If no target element, append to the end
        return pinnedFavicons.querySelectorAll('.pinned-favicon').length;
    }

    const pinnedElements = Array.from(pinnedFavicons.querySelectorAll('.pinned-favicon'));
    const afterIndex = pinnedElements.indexOf(afterElement);

    if (afterIndex === -1) {
        // Fallback: append to end if element not found
        return pinnedElements.length;
    }

    if (position === 'left') {
        return afterIndex; // Insert before the target element
    } else { // position === 'right'
        return afterIndex + 1; // Insert after the target element  
    }
}

// Helper function to set up drag event listeners for tab elements
function setupTabDragHandlers(tabElement) {
    tabElement.addEventListener('dragstart', () => {
        tabElement.classList.add('dragging');
        // Track the source folder (if any) so we can resync collapsed-folder projections after drop.
        dragSourceFolderElement = tabElement.closest('.folder');
    });

    tabElement.addEventListener('dragend', () => {
        tabElement.classList.remove('dragging');
        dragSourceFolderElement = null;
    });
}

// Variables for folder auto-open functionality
let folderOpenTimer = null;
let currentHoveredFolder = null;
let dragSourceFolderElement = null;

// Helper function to programmatically open a folder
function openFolder(folderElement) {
    if (!folderElement.classList.contains('collapsed')) return; // Already open

    const folderContent = folderElement.querySelector('.folder-content');
    const folderToggle = folderElement.querySelector('.folder-toggle');
    const folderIcon = folderElement.querySelector('.folder-icon');

    folderElement.classList.remove('collapsed');
    folderContent.classList.remove('collapsed');
    folderToggle.classList.remove('collapsed');

    // Update icon to show folder is open
    if (folderIcon) {
    updateFolderIcon(folderElement);
    }

    // If this folder had "collapsed open tabs" projected, move them back into content now that it's open.
    syncCollapsedFolderTabs(folderElement);
}

// Helper function to start auto-open timer for a folder
function startFolderOpenTimer(folderElement) {
    clearFolderOpenTimer(); // Clear any existing timer

    currentHoveredFolder = folderElement;
    folderOpenTimer = setTimeout(() => {
        if (currentHoveredFolder === folderElement && folderElement.classList.contains('collapsed')) {
            openFolder(folderElement);
        }
        folderOpenTimer = null;
        currentHoveredFolder = null;
    }, 250); // 750ms delay like macOS Finder
}

// Helper function to clear the folder auto-open timer
function clearFolderOpenTimer() {
    if (folderOpenTimer) {
        clearTimeout(folderOpenTimer);
        folderOpenTimer = null;
    }
    currentHoveredFolder = null;
}

async function activateSidebar(updateTab = true) {
    Logger.log('Activating sidebar');
    if (!sidebarState) {
        return;
    }
    applySidebarColor(sidebarState.color);
    if (!updateTab) {
        return;
    }

    if (!sidebarState.lastTab) {
        return;
    }

    try {
        await chrome.tabs.update(sidebarState.lastTab, { active: true });
        activateTabInDOM(sidebarState.lastTab);
    } catch (error) {
        Logger.warn('Failed to activate last tab:', error);
    }
}

function saveSidebarState() {
    Logger.log('Saving sidebar state...', sidebarState);
    Utils.saveSidebarState(sidebarState || {}).then(() => {
        Logger.log('Sidebar state saved successfully');
    });
}

async function cleanTemporaryTabs() {
    if (!sidebarState) {
        return;
    }

    const tabIdsToClose = [...(sidebarState.temporaryTabs ?? [])];
    if (tabIdsToClose.length === 0) {
        return;
    }

    const currentTabs = await chrome.tabs.query({ currentWindow: true });
    const remainingTabs = currentTabs.filter(tab => !tabIdsToClose.includes(tab.id));

    let fallbackTab = null;
    if (remainingTabs.length === 0) {
        fallbackTab = await chrome.tabs.create({ active: true });
    }

    sidebarState.temporaryTabs = fallbackTab ? [fallbackTab.id] : [];
    sidebarState.lastTab = sidebarState.pinnedTabIds[0] ?? fallbackTab?.id ?? null;
    saveSidebarState();

    try {
        await chrome.tabs.remove(tabIdsToClose);
    } catch (error) {
        Logger.warn('Failed to clean temporary tabs:', error);
    }
}

async function moveTabToPinned(state, tab) {
    state.temporaryTabs = state.temporaryTabs.filter(id => id !== tab.id);
    if (!state.pinnedTabIds.includes(tab.id)) {
        state.pinnedTabIds.push(tab.id);
    }
    const bookmarkRoot = await getBookmarkRootFolder();
    const bookmarks = await chrome.bookmarks.getChildren(bookmarkRoot.id);
    const existingBookmark = BookmarkUtils.findBookmarkByUrl(bookmarks, tab.url);
    let bookmarkIdToStore = existingBookmark?.id || null;
    if (!existingBookmark) {
        // delete existing bookmark
        await BookmarkUtils.removeBookmarkByUrl(bookmarkRoot.id, tab.url);

        const created = await chrome.bookmarks.create({
            parentId: bookmarkRoot.id,
            title: tab.title,
            url: tab.url
        });
        bookmarkIdToStore = created?.id || null;
    }

    // Track the original pinned URL for Arc-like "Back to Pinned URL" behavior.
    await Utils.setPinnedTabState(tab.id, { pinnedUrl: tab.url, bookmarkId: bookmarkIdToStore });

    // Update chevron state after moving tab to pinned
    const sidebarView = document.querySelector('.sidebar-view');
    if (sidebarView) {
        const pinnedContainer = sidebarView.querySelector('[data-tab-type="pinned"]');
        updateChevronState(sidebarView, pinnedContainer);
    }

    // Update placeholders after moving tab to pinned
    updatePinnedSectionPlaceholders();

    await reconcileTabOrdering({ source: 'arcify', movedTabId: tab.id });
}

async function moveTabToTemp(state, tab) {
    const bookmarkRoot = await getBookmarkRootFolder();
    await BookmarkUtils.removeBookmarkByUrl(bookmarkRoot.id, tab.url);

    state.pinnedTabIds = state.pinnedTabIds.filter(id => id !== tab.id);
    if (!state.temporaryTabs.includes(tab.id)) {
        state.temporaryTabs.push(tab.id);
    }

    await Utils.removePinnedTabState(tab.id);

    saveSidebarState();

    // Update chevron state after moving tab from pinned
    const sidebarView = document.querySelector('.sidebar-view');
    if (sidebarView) {
        const pinnedContainer = sidebarView.querySelector('[data-tab-type="pinned"]');
        updateChevronState(sidebarView, pinnedContainer);
    }

    await reconcileTabOrdering({ source: 'arcify', movedTabId: tab.id });
}

// Helper function to manage folder placeholder state
function updateFolderPlaceholder(folderElement) {
    if (!folderElement) return;

    const folderContent = folderElement.querySelector('.folder-content');
    const placeholder = folderElement.querySelector('.tab-placeholder');

    if (!folderContent || !placeholder) return;

    // Count actual tab elements (not placeholders)
    const tabElements = folderContent.querySelectorAll('.tab:not(.tab-placeholder)');
    const isEmpty = tabElements.length === 0;

    if (isEmpty) {
        placeholder.classList.remove('hidden');
        Logger.log('Showing placeholder for empty folder');
    } else {
        placeholder.classList.add('hidden');
        Logger.log('Hiding placeholder for populated folder');
    }
}

function updateFolderIcon(folderElement) {
    if (!folderElement) return;
    const folderIcon = folderElement.querySelector('.folder-icon');
    if (!folderIcon) return;
    const isCollapsed = folderElement.classList.contains('collapsed');
    const hasOpenTabs = folderElement.classList.contains('has-open-tabs');
    folderIcon.innerHTML = isCollapsed
        ? (hasOpenTabs ? FOLDER_CLOSED_DOTS_ICON : FOLDER_CLOSED_ICON)
        : FOLDER_OPEN_ICON;
}

// Arc-like: when a folder is collapsed, show open bookmark tabs (active Chrome tabs) for that folder.
// Implementation detail: we MOVE the existing open tab elements between containers (no duplicates),
// so tab updates/active highlighting continue to work consistently.
function syncCollapsedFolderTabs(folderElement) {
    if (!folderElement) return;
    const collapsedContainer = folderElement.querySelector('.folder-collapsed-tabs');
    const folderContent = folderElement.querySelector('.folder-content');
    if (!collapsedContainer || !folderContent) return;

    const isCollapsed = folderElement.classList.contains('collapsed');

    if (isCollapsed) {
        // If any bookmark-only tabs ended up in the collapsed container (e.g., tab got closed while collapsed),
        // move them back into the real folder content so the collapsed view only shows open tabs.
        Array.from(collapsedContainer.querySelectorAll('.tab.bookmark-only')).forEach(el => {
            folderContent.appendChild(el);
        });

        // Always clear any previously projected open tabs back into folder content first.
        Array.from(collapsedContainer.querySelectorAll('.tab:not(.bookmark-only)')).forEach(el => {
            folderContent.appendChild(el);
        });

        if (showAllOpenTabsInCollapsedFolders) {
            // Arcify mode: show all open (non-bookmark-only) tabs even when folder is collapsed.
            const openTabs = Array.from(folderContent.querySelectorAll('.tab'))
                .filter(t => !t.classList.contains('bookmark-only') && t.dataset.tabId);
            openTabs.forEach(t => collapsedContainer.appendChild(t));
        } else {
            // Arc mode: show tabs that are active OR were previously active while folder was collapsed.
            // This list resets when user manually opens/closes the folder.
            let shownTabIds = collapsedFolderShownTabs.get(folderElement);
            
            // Also seed the currently active tab if it's in this folder (handles initialization case).
            if (activeChromeTabId) {
                const activeTabEl = folderContent.querySelector(`.tab[data-tab-id="${activeChromeTabId}"]:not(.bookmark-only)`);
                if (activeTabEl) {
                    if (!shownTabIds) {
                        shownTabIds = new Set();
                        collapsedFolderShownTabs.set(folderElement, shownTabIds);
                    }
                    shownTabIds.add(activeChromeTabId);
                }
            }
            
            if (shownTabIds && shownTabIds.size > 0) {
                shownTabIds.forEach(tabId => {
                    const tabEl = folderContent.querySelector(`.tab[data-tab-id="${tabId}"]:not(.bookmark-only)`);
                    if (tabEl) {
                        collapsedContainer.appendChild(tabEl);
                    }
                });
            }
        }
    } else {
        // Expanded: move everything back into the folder content.
        Array.from(collapsedContainer.querySelectorAll('.tab')).forEach(t => folderContent.appendChild(t));
    }

    // Arc-like: indicate collapsed folder contains an open tab (in Arc mode this only happens for active tab).
    const hasOpenTabs = isCollapsed && Boolean(collapsedContainer.querySelector('.tab:not(.bookmark-only)'));
    folderElement.classList.toggle('has-open-tabs', hasOpenTabs);
    updateFolderIcon(folderElement);

    // Recompute placeholder visibility now that DOM contents may have changed.
    updateFolderPlaceholder(folderElement);
}

function syncCollapsedFolders() {
    const sidebarView = document.querySelector('.sidebar-view');
    if (!sidebarView) return;
    sidebarView.querySelectorAll('.folder').forEach(folderEl => syncCollapsedFolderTabs(folderEl));
}

// Update all pinned section placeholders in the current sidebar view (folders + main section)
function updatePinnedSectionPlaceholders() {
    const sidebarView = document.querySelector('.sidebar-view');
    if (!sidebarView) return;

    const folders = sidebarView.querySelectorAll('.folder');
    folders.forEach(folder => {
        updateFolderPlaceholder(folder);
    });

    const pinnedContainer = sidebarView.querySelector('[data-tab-type="pinned"]');
    const placeholderContainer = sidebarView.querySelector('.placeholder-container');

    if (pinnedContainer && placeholderContainer) {
        const placeholder = placeholderContainer.querySelector('.tab-placeholder');
        if (placeholder) {
            // Check if pinned container has any actual content (tabs or folders, not placeholders)
            const hasContent = pinnedContainer.querySelectorAll('.tab:not(.tab-placeholder), .folder').length > 0;

            if (hasContent) {
                placeholder.classList.add('hidden');
            } else {
                placeholder.classList.remove('hidden');
            }
        }
    }
}

// Convert favorite tab (pinned-favicon) to proper tab element
async function convertFavoriteToTab(draggingElement, targetIsPinned) {
    const tabId = parseInt(draggingElement.dataset.tabId);

    // Unpin from Chrome favorites
    await chrome.tabs.update(tabId, { pinned: false });

    // Get fresh tab data and create proper UI element
    const tab = await chrome.tabs.get(tabId);
    const newTabElement = await createTabElement(tab, targetIsPinned, false);

    // Replace the small favicon with full tab element
    draggingElement.replaceWith(newTabElement);

    // Refresh favorites area to remove the original
    updatePinnedFavicons();

    return { tab, newTabElement };
}

// Handle bookmark operations during drop events
async function handleBookmarkOperations(event, draggingElement, container, targetFolder) {
    // Validate required elements exist
    if (!draggingElement || !container || !event) {
        Logger.warn('Missing required elements for bookmark operations');
        return;
    }

    // Handle tab being moved to pinned section or folder (both open tabs and bookmark-only tabs)
    if (container.dataset.tabType === 'pinned' && (draggingElement.dataset.tabId || draggingElement.dataset.url)) {
        // Handle favorite tab conversion
        if (draggingElement.classList.contains('pinned-favicon')) {
            await convertFavoriteToTab(draggingElement, true);
            return; // Exit early, conversion complete
        }

        Logger.log("Tab dropped to pinned section or folder");

        // Determine if this is a bookmark-only tab or a regular tab
        const isBookmarkOnly = !draggingElement.dataset.tabId && draggingElement.dataset.url;
        Logger.log("Processing drag drop - isBookmarkOnly:", isBookmarkOnly);

        try {
            let tab;
            let tabId;

            if (isBookmarkOnly) {
                // For bookmark-only tabs, create a synthetic tab object from DOM data
                const titleElement = draggingElement.querySelector('.tab-title-display');
                tab = {
                    id: null,
                    url: draggingElement.dataset.url,
                    title: titleElement ? titleElement.textContent : 'Untitled',
                    favIconUrl: null
                };
                tabId = null;
                Logger.log("Created synthetic tab object for bookmark-only:", tab);
            } else {
                // For regular tabs, fetch the actual tab object
                tabId = parseInt(draggingElement.dataset.tabId);
                tab = await chrome.tabs.get(tabId);
                Logger.log("Fetched real tab object:", tab);
            }
            const sidebarView = container.closest('.sidebar-view');
            if (!sidebarView) {
                Logger.error('Could not find parent sidebar element');
                return;
            }

            const state = sidebarState;
            if (!state) {
                Logger.error('Sidebar state not initialized');
                return;
            }

            if (!tab) {
                Logger.error(`Tab not found for ID: ${tabId}`);
                return;
            }

            if (!isBookmarkOnly && tabId) {
                state.temporaryTabs = state.temporaryTabs.filter(id => id !== tabId);
                if (!state.pinnedTabIds.includes(tabId)) {
                    state.pinnedTabIds.push(tabId);
                }
                Logger.log("Updated sidebar state for regular tab:", tabId);
            } else {
                Logger.log("Skipping sidebar state update for bookmark-only tab");
            }

            // Determine the target folder
            const targetFolderElement = targetFolder ? targetFolder.closest('.folder') : null;

            // Add to bookmarks if URL doesn't exist
            const bookmarkRoot = await getBookmarkRootFolder();
            if (bookmarkRoot) {
                let parentId = bookmarkRoot.id;
                if (targetFolderElement) {
                    Logger.log("moving into a folder");
                    const folderName = targetFolderElement.querySelector('.folder-name').value;
                    const existingFolders = await chrome.bookmarks.getChildren(bookmarkRoot.id);
                    let folder = existingFolders.find(f => f.title === folderName);
                    if (!folder) {
                        folder = await chrome.bookmarks.create({
                            parentId: bookmarkRoot.id,
                            title: folderName
                        });
                    }
                    parentId = folder.id;

                    // Check if bookmark already exists in the target folder
                    const existingBookmarks = await chrome.bookmarks.getChildren(parentId);
                    const bookmarkAlreadyInTarget = Boolean(BookmarkUtils.findBookmarkByUrl(existingBookmarks, tab.url));
                    if (bookmarkAlreadyInTarget) {
                        Logger.log('Bookmark already exists in folder:', folderName);
                    }

                    // Ensure we don't show duplicate UI entries for the same URL inside the folder:
                    // if the folder already has a bookmark-only item for this URL, remove it when dropping an open tab.
                    const targetFolderContentEl = targetFolderElement.querySelector('.folder-content');
                    if (targetFolderContentEl && !isBookmarkOnly && tab?.url) {
                        const esc = (s) => (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(s) : s.replace(/"/g, '\\"');
                        const dupe = targetFolderContentEl.querySelector(`.tab.bookmark-only[data-url="${esc(tab.url)}"]`);
                        if (dupe && dupe !== draggingElement) {
                            dupe.remove();
                        }
                    }

                    // Only move the bookmark in Chrome bookmarks if it's not already in the target folder.
                    if (!bookmarkAlreadyInTarget) {
                        // Find and remove the bookmark from its original location
                        await BookmarkUtils.removeBookmarkByUrl(bookmarkRoot.id, tab.url);

                        // Create the bookmark in the new location
                        await chrome.bookmarks.create({
                            parentId: parentId,
                            title: tab.title,
                            url: tab.url
                        });
                    }

                    // Keep folder placeholder state accurate (DOM was already positioned by drop handler).
                    updateFolderPlaceholder(targetFolderElement);
                } else {
                    await moveTabToPinned(state, tab);
                }
            }

            saveSidebarState();

            // Update all folder placeholders after bookmark operations
            updatePinnedSectionPlaceholders();
        } catch (error) {
            Logger.error('Error handling pinned tab drop:', error);
            // Update placeholders even if there was an error
            updatePinnedSectionPlaceholders();
        }
    } else if (container.dataset.tabType === 'temporary' && draggingElement.dataset.tabId) {
        // Handle favorite tab conversion
        if (draggingElement.classList.contains('pinned-favicon')) {
            const { tab } = await convertFavoriteToTab(draggingElement, false);
            const state = sidebarState;
            if (state) moveTabToTemp(state, tab);
            return; // Exit early, conversion complete
        }

        Logger.log("Tab dropped to temporary section");
        const tabId = parseInt(draggingElement.dataset.tabId);

        try {
            const tab = await chrome.tabs.get(tabId);
            const state = sidebarState;
            if (state && tab) {
                moveTabToTemp(state, tab);

                // Update all folder placeholders after removing bookmark
                updatePinnedSectionPlaceholders();
            }
        } catch (error) {
            Logger.error('Error handling temporary tab drop:', error);
            // Update placeholders even if there was an error
            updatePinnedSectionPlaceholders();
        }
    } else if (draggingElement && draggingElement.classList.contains('pinned-favicon') && draggingElement.dataset.tabId) {
        const tabId = parseInt(draggingElement.dataset.tabId);
        try {
            // 1. Unpin the tab from Chrome favorites
            await chrome.tabs.update(tabId, { pinned: false });

            // Update all folder placeholders after conversion
            updatePinnedSectionPlaceholders();
        } catch (error) {
            Logger.error('Error converting favorite tab to regular tab:', error);
            // Update placeholders even if there was an error
            updatePinnedSectionPlaceholders();
        }
    }
}

/**
 * Sync tab order from DOM to Chrome after drag and drop reordering
 * @param {HTMLElement} draggingElement - The tab element that was dragged
 * @param {HTMLElement} container - The container the tab was dropped into
 */
function uniqPreserveOrder(ids) {
    const out = [];
    const seen = new Set();
    for (const id of ids) {
        if (!id) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

/**
 * Flatten visual order of the pinned section:
 * - root-level `.tab[data-tab-id]` in order
 * - then folder contents (per folder in DOM order), `.tab[data-tab-id]` in order
 *
 * Bookmark-only items (no tabId) are skipped since they don't exist in Chrome.
 */
function getFlattenedPinnedSectionTabIds(collectionElement) {
    const pinnedContainer = getPinnedContainer(collectionElement);
    if (!pinnedContainer) return [];

    const out = [];
    const children = Array.from(pinnedContainer.children);
    for (const child of children) {
        if (child.classList?.contains('tab') && child.dataset?.tabId) {
            out.push(parseInt(child.dataset.tabId));
            continue;
        }
        if (child.classList?.contains('folder')) {
            const folderContent = child.querySelector('.folder-content');
            if (!folderContent) continue;
            const folderTabs = Array.from(folderContent.querySelectorAll('.tab[data-tab-id]'))
                .map(el => parseInt(el.dataset.tabId));
            out.push(...folderTabs);
        }
    }
    return uniqPreserveOrder(out);
}

function getTempSectionTabIds(collectionElement) {
    const tempContainer = getTempContainer(collectionElement);
    if (!tempContainer) return [];
    return uniqPreserveOrder(
        Array.from(tempContainer.querySelectorAll('.tab[data-tab-id]')).map(el => parseInt(el.dataset.tabId))
    );
}

async function reconcileTabOrdering(opts = {}) {
    saveSidebarState();
}

/**
 * Called after an Arcify drag+drop to update the sidebar model (pinnedTabIds/temporaryTabs)
 * from the DOM, then reconcile Chrome ordering accordingly.
 */
async function handleArcifyOrderChangeAfterDropByTabId(tabId, container) {
    if (!tabId || !container) return;
    const sidebarView = container.closest('.sidebar-view');
    if (!sidebarView || !sidebarState) return;

    const tabType = container.dataset.tabType;
    const invertTabOrder = await Utils.getInvertTabOrder();
    if (tabType === 'temporary') {
        const tempIdsDisplayOrder = getTempSectionTabIds(sidebarView);
        const tempIdsChromeOrder = invertTabOrder ? [...tempIdsDisplayOrder].reverse() : tempIdsDisplayOrder;
        const existing = (sidebarState.temporaryTabs ?? []).filter(id => !tempIdsChromeOrder.includes(id));
        sidebarState.temporaryTabs = uniqPreserveOrder([...tempIdsChromeOrder, ...existing]);
    } else if (tabType === 'pinned') {
        const pinnedIdsDisplayOrder = getFlattenedPinnedSectionTabIds(sidebarView);
        const pinnedIdsChromeOrder = invertTabOrder ? [...pinnedIdsDisplayOrder].reverse() : pinnedIdsDisplayOrder;
        const existing = (sidebarState.pinnedTabIds ?? []).filter(id => !pinnedIdsChromeOrder.includes(id));
        sidebarState.pinnedTabIds = uniqPreserveOrder([...pinnedIdsChromeOrder, ...existing]);
    } else {
        return;
    }

    await reconcileTabOrdering({ source: 'arcify', movedTabId: tabId });
}

async function setupDragAndDrop(pinnedContainer, tempContainer) {
    Logger.log('Setting up drag and drop handlers...');
    [pinnedContainer, tempContainer].forEach(container => {
        container.addEventListener('dragover', e => {
            e.preventDefault();
            const draggingElement = document.querySelector('.dragging');
            if (draggingElement) {
                const targetFolder = e.target.closest('.folder-content');
                const targetContainer = targetFolder || container;

                // Check for collapsed folder auto-open functionality
                const folderElement = e.target.closest('.folder');
                if (folderElement && folderElement.classList.contains('collapsed')) {
                    // Start timer to auto-open collapsed folder if hovering over it
                    if (currentHoveredFolder !== folderElement) {
                        startFolderOpenTimer(folderElement);
                    }
                } else {
                    // Clear timer if not hovering over a collapsed folder
                    clearFolderOpenTimer();
                }

                // Get the element we're dragging over to show drop indicator
                const afterElement = getDragAfterElementTabs(targetContainer, e.clientY);
                if (afterElement && targetContainer.contains(afterElement)) {
                    // Check if this is a placeholder (empty container)
                    if (afterElement.classList.contains('tab-placeholder')) {
                        // Show visual feedback on the placeholder itself
                        afterElement.classList.add('drag-over');
                        hideAllDropIndicators(); // Don't show traditional indicators for placeholders
                    } else {
                        // Show traditional drop indicators for actual tabs/folders
                        const position = getDropPosition(afterElement, e.clientX, e.clientY, false);
                        showDropIndicator(afterElement, position, false);
                        // Remove any placeholder drag-over state in this container
                        const placeholder = targetContainer.querySelector('.tab-placeholder');
                        if (placeholder) placeholder.classList.remove('drag-over');
                    }
                } else {
                    // If no specific element, hide indicators
                    hideAllDropIndicators();
                    // Remove any placeholder drag-over state in this container
                    const placeholder = targetContainer.querySelector('.tab-placeholder');
                    if (placeholder) placeholder.classList.remove('drag-over');
                }

                // Note: Actual bookmark operations moved to drop event for proper architecture
            }
        });

        // Add dragleave handler to hide indicators when leaving container
        container.addEventListener('dragleave', e => {
            // Only hide indicators if we're actually leaving the container (not moving to a child)
            if (!container.contains(e.relatedTarget)) {
                hideAllDropIndicators();
                // Remove any placeholder drag-over state in this container
                const placeholder = container.querySelector('.tab-placeholder');
                if (placeholder) placeholder.classList.remove('drag-over');
                // Clear folder auto-open timer when leaving the container
                clearFolderOpenTimer();
            }
        });

        // Add drop handler to position elements and hide indicators
        container.addEventListener('drop', async e => {
            e.preventDefault();
            hideAllDropIndicators();
            // Remove any placeholder drag-over state in this container
            const placeholder = container.querySelector('.tab-placeholder');
            if (placeholder) placeholder.classList.remove('drag-over');
            // Clear folder auto-open timer on drop
            clearFolderOpenTimer();

            const draggingElement = document.querySelector('.dragging');
            if (draggingElement) {
                const droppedTabId = draggingElement.dataset.tabId ? parseInt(draggingElement.dataset.tabId) : null;
                // If dropping on a folder header / collapsed folder area, treat it as dropping into that folder.
                let targetFolder = e.target.closest('.folder-content');
                let targetFolderElement = targetFolder ? targetFolder.closest('.folder') : null;

                if (!targetFolder) {
                    const folderUnderPointer = e.target.closest('.folder');
                    if (folderUnderPointer) {
                        openFolder(folderUnderPointer); // ensures folder is expanded and projections are synced
                        targetFolderElement = folderUnderPointer;
                        targetFolder = folderUnderPointer.querySelector('.folder-content');
                    }
                }

                const targetContainer = targetFolder || container;

                // Calculate drop position using same logic as indicators
                const afterElement = getDragAfterElementTabs(targetContainer, e.clientY);
                if (afterElement && targetContainer.contains(afterElement)) {
                    // Check if this is a placeholder (empty container)
                    if (afterElement.classList.contains('tab-placeholder')) {
                        // Empty container - append directly and hide placeholder
                        targetContainer.appendChild(draggingElement);
                        afterElement.classList.add('hidden');
                    } else {
                        // Normal positioning logic for actual tabs/folders
                        const position = getDropPosition(afterElement, e.clientX, e.clientY, false);

                        // Position element based on indicator logic
                        if (position === 'above') {
                            targetContainer.insertBefore(draggingElement, afterElement);
                        } else { // 'below'
                            const nextSibling = afterElement.nextElementSibling;
                            if (nextSibling) {
                                targetContainer.insertBefore(draggingElement, nextSibling);
                            } else {
                                targetContainer.appendChild(draggingElement);
                            }
                        }
                    }
                } else {
                    // Fallback: append to end if no specific target
                    targetContainer.appendChild(draggingElement);
                }

                // Handle bookmark operations after DOM positioning is complete
                await handleBookmarkOperations(e, draggingElement, container, targetFolder);

                // Resync collapsed-folder projections/icons after move (source + destination)
                if (dragSourceFolderElement) {
                    syncCollapsedFolderTabs(dragSourceFolderElement);
                }
                if (targetFolderElement && targetFolderElement !== dragSourceFolderElement) {
                    syncCollapsedFolderTabs(targetFolderElement);
                }

                // Update the model from the DOM (Arcify is source of truth here), then reconcile Chrome.
                // This is intentionally done after bookmark operations so section membership is correct.
                if (droppedTabId) {
                    await handleArcifyOrderChangeAfterDropByTabId(droppedTabId, container);
                }
            }
        });
    });
}

// Function to set up drag and drop for placeholder containers to make entire placeholder area droppable
function setupPlaceholderDragAndDrop(placeholderContainer, pinnedContainer) {
    Logger.log('Setting up placeholder drag and drop handlers...');

    placeholderContainer.addEventListener('dragover', e => {
        e.preventDefault();
        const draggingElement = document.querySelector('.dragging');
        if (draggingElement) {
            // Check if pinned container is empty (no tabs or folders, only placeholder)
            const hasContent = pinnedContainer.querySelectorAll('.tab:not(.tab-placeholder), .folder').length > 0;

            if (!hasContent) {
                // Container is empty - show visual feedback on placeholder
                const placeholder = placeholderContainer.querySelector('.tab-placeholder');
                if (placeholder) {
                    placeholder.classList.add('drag-over');
                }
                hideAllDropIndicators();
            }
        }
    });

    placeholderContainer.addEventListener('dragleave', e => {
        // Only hide if leaving the placeholder container entirely
        if (!placeholderContainer.contains(e.relatedTarget)) {
            const placeholder = placeholderContainer.querySelector('.tab-placeholder');
            if (placeholder) {
                placeholder.classList.remove('drag-over');
            }
        }
    });

    placeholderContainer.addEventListener('drop', async e => {
        e.preventDefault();
        const placeholder = placeholderContainer.querySelector('.tab-placeholder');
        if (placeholder) {
            placeholder.classList.remove('drag-over');
        }
        hideAllDropIndicators();

        const draggingElement = document.querySelector('.dragging');
        if (draggingElement) {
            // Check if pinned container is empty
            const hasContent = pinnedContainer.querySelectorAll('.tab:not(.tab-placeholder), .folder').length > 0;

            if (!hasContent) {
                // Forward the drop to the pinned container by simulating the drop event
                Logger.log('Forwarding placeholder drop to pinned container');

                // Create a synthetic drop event for the pinned container
                const syntheticEvent = new DragEvent('drop', {
                    bubbles: true,
                    cancelable: true,
                    dataTransfer: e.dataTransfer,
                    clientX: e.clientX,
                    clientY: e.clientY,
                    screenX: e.screenX,
                    screenY: e.screenY
                });

                // Dispatch the event on the pinned container
                pinnedContainer.dispatchEvent(syntheticEvent);
            }
        }
    });
}

async function createNewFolder(sidebarView) {
    const pinnedContainer = sidebarView.querySelector('[data-tab-type="pinned"]');
    const folderTemplate = document.getElementById('folderTemplate');
    const newFolder = folderTemplate.content.cloneNode(true);
    const folderElement = newFolder.querySelector('.folder');
    const folderHeader = folderElement.querySelector('.folder-header');
    const folderTitle = folderElement.querySelector('.folder-title');
    const folderNameInput = folderElement.querySelector('.folder-name');
    const folderIcon = folderElement.querySelector('.folder-icon');
    const folderToggle = folderElement.querySelector('.folder-toggle');
    const folderContent = folderElement.querySelector('.folder-content');

    // Open new folder by default
    folderElement.classList.toggle('collapsed');
    folderContent.classList.toggle('collapsed');
    folderToggle.classList.toggle('collapsed');

    // Set up initial display for new folder
    folderNameInput.style.display = 'inline-block';
    folderTitle.style.display = 'none';

    folderHeader.addEventListener('click', () => {
        // Clear the tracked shown tabs when user manually toggles the folder (Arc behavior).
        collapsedFolderShownTabs.delete(folderElement);
        folderElement.classList.toggle('collapsed');
        folderContent.classList.toggle('collapsed');
        folderToggle.classList.toggle('collapsed');
        folderIcon.innerHTML = folderElement.classList.contains('collapsed') ? FOLDER_CLOSED_ICON : FOLDER_OPEN_ICON;
        syncCollapsedFolderTabs(folderElement);
    });

    // Set up folder name input
    folderNameInput.addEventListener('change', async () => {
        const bookmarkRoot = await getBookmarkRootFolder();
        const existingFolders = await chrome.bookmarks.getChildren(bookmarkRoot.id);
        const folder = existingFolders.find(f => f.title === folderNameInput.value);
        if (!folder) {
            await chrome.bookmarks.create({
                parentId: bookmarkRoot.id,
                title: folderNameInput.value
            });
            folderNameInput.style.display = 'none';
            folderTitle.innerHTML = folderNameInput.value;
            folderTitle.style.display = 'inline';
        }
    });

    // Add double-click functionality for folder name editing (for new folders)
    folderHeader.addEventListener('dblclick', (e) => {
        // Prevent dblclick on folder toggle button from triggering rename
        if (e.target === folderToggle) return;

        folderTitle.style.display = 'none';
        folderNameInput.style.display = 'inline-block';
        folderNameInput.readOnly = false;
        folderNameInput.disabled = false;
        folderNameInput.select();
        folderNameInput.focus();
    });

    const saveOrCancelNewFolderEdit = async (save) => {
        if (save) {
            const newName = folderNameInput.value.trim();
            if (newName) {
                const bookmarkRoot = await getBookmarkRootFolder();
                const existingFolders = await chrome.bookmarks.getChildren(bookmarkRoot.id);
                const folder = existingFolders.find(f => f.title === newName);
                if (!folder) {
                    await chrome.bookmarks.create({
                        parentId: bookmarkRoot.id,
                        title: newName
                    });
                }
            }
        }
        // Update display regardless of save/cancel
        folderNameInput.style.display = 'none';
        folderTitle.innerHTML = folderNameInput.value || 'Untitled';
        folderTitle.style.display = 'inline';
    };

    folderNameInput.addEventListener('blur', () => saveOrCancelNewFolderEdit(true));
    folderNameInput.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            await saveOrCancelNewFolderEdit(true);
            folderNameInput.blur();
        } else if (e.key === 'Escape') {
            await saveOrCancelNewFolderEdit(false);
            folderNameInput.blur();
        }
    });

    // Add the new folder to the pinned container
    pinnedContainer.appendChild(folderElement);

    // Set up context menu for the new folder
    setupFolderContextMenu(folderElement, { name: sidebarView.querySelector('.sidebar-name').value });

    // Ensure new empty folder shows placeholder
    updateFolderPlaceholder(folderElement);

    folderNameInput.focus();
}

async function loadTabs(state, pinnedContainer, tempContainer) {
    Logger.log('Loading tabs for sidebar:', state.id);
    Logger.log('Pinned bookmarks in sidebar:', state.pinnedTabIds);

    // Track which *tabIds* are already represented in the pinned bookmarks UI so we don't double-render them
    // in the temporary section. We intentionally avoid URL-key based exclusion here because multiple open
    // tabs can share the same base URL (e.g. abc.com?x=y and abc.com?x=z).
    const representedPinnedTabIds = new Set();
    try {
        const invertTabOrder = await Utils.getInvertTabOrder();
        const tabs = await chrome.tabs.query({ currentWindow: true });
        const pinnedStatesById = await Utils.getPinnedTabStates();
        const pinnedTabs = await chrome.tabs.query({ pinned: true, currentWindow: true });
        const pinnedUrls = new Set(pinnedTabs.map(tab => tab.url));

        const collectionFolder = await getBookmarkRootFolder();

        if (collectionFolder) {
            // Recursive function to process bookmarks and folders
            async function processBookmarkNode(node, container) {
                const bookmarks = await chrome.bookmarks.getChildren(node.id);
                Logger.log('Processing bookmarks:', bookmarks);
                const processedUrls = new Set();

                const itemsToRender = invertTabOrder ? [...bookmarks].reverse() : bookmarks;
                for (const item of itemsToRender) {
                    if (!item.url) {
                        // This is a folder
                        const folderTemplate = document.getElementById('folderTemplate');
                        const newFolder = folderTemplate.content.cloneNode(true);
                        const folderElement = newFolder.querySelector('.folder');
                        const folderHeader = folderElement.querySelector('.folder-header');
                        const folderIcon = folderElement.querySelector('.folder-icon');
                        const folderTitle = folderElement.querySelector('.folder-title');
                        const folderNameInput = folderElement.querySelector('.folder-name');
                        const folderContent = folderElement.querySelector('.folder-content');
                        const folderToggle = folderElement.querySelector('.folder-toggle');
                        const placeHolderElement = folderElement.querySelector('.tab-placeholder');
                        // Set up folder toggle functionality
                        // Add context menu for folder
                        setupFolderContextMenu(folderElement, state, item);

                        folderHeader.addEventListener('click', () => {
                            // Clear the tracked shown tabs when user manually toggles the folder (Arc behavior).
                            collapsedFolderShownTabs.delete(folderElement);
                            folderElement.classList.toggle('collapsed');
                            folderContent.classList.toggle('collapsed');
                            folderToggle.classList.toggle('collapsed');
                            updateFolderIcon(folderElement);
                            updateFolderIcon(folderElement);
                            syncCollapsedFolderTabs(folderElement);
                        });

                        // Add double-click functionality for folder name editing
                        folderHeader.addEventListener('dblclick', (e) => {
                            // Prevent dblclick on folder toggle button from triggering rename
                            if (e.target === folderToggle) return;

                            folderTitle.style.display = 'none';
                            folderNameInput.style.display = 'inline-block';
                            folderNameInput.readOnly = false;
                            folderNameInput.disabled = false;
                            folderNameInput.select();
                            folderNameInput.focus();
                        });

                        const saveOrCancelFolderEdit = async (save) => {
                            if (save) {
                                const newName = folderNameInput.value.trim();
                                if (newName && newName !== item.title) {
                                    try {
                                        await chrome.bookmarks.update(item.id, { title: newName });
                                        item.title = newName; // Update local item object
                                    } catch (error) {
                                        Logger.error("Error updating folder name:", error);
                                    }
                                }
                            }
                            // Update display regardless of save/cancel
                            folderNameInput.value = item.title;
                            folderNameInput.readOnly = true;
                            folderNameInput.disabled = true;
                            folderNameInput.style.display = 'none';
                            folderTitle.innerHTML = item.title;
                            folderTitle.style.display = 'inline';
                        };

                        folderNameInput.addEventListener('blur', () => saveOrCancelFolderEdit(true));
                        folderNameInput.addEventListener('keydown', async (e) => {
                            if (e.key === 'Enter') {
                                e.preventDefault();
                                await saveOrCancelFolderEdit(true);
                                folderNameInput.blur();
                            } else if (e.key === 'Escape') {
                                await saveOrCancelFolderEdit(false);
                                folderNameInput.blur();
                            }
                        });

                        folderNameInput.value = item.title;
                        folderNameInput.readOnly = true;
                        folderNameInput.disabled = true;
                        folderNameInput.style.display = 'none';
                        folderTitle.innerHTML = item.title;
                        folderTitle.style.display = 'inline';

                        container.appendChild(folderElement);

                        // Recursively process the folder's contents
                        await processBookmarkNode(item, folderElement.querySelector('.folder-content'));

                        // Update folder placeholder state after loading contents
                        updateFolderPlaceholder(folderElement);
                        // Initial sync for collapsed folders (template starts collapsed).
                        syncCollapsedFolderTabs(folderElement);
                    } else {
                        // This is a bookmark
                        if (!processedUrls.has(item.url) && !pinnedUrls.has(item.url)) {
                            // Choose ONE open tab (if any) to represent this bookmark:
                            // 1) Strongest: pinned state points to this bookmarkId
                            // 2) Exact URL match
                            // 3) Base URL match (origin+pathname), but only if not already used for another bookmark
                            const byBookmarkId = tabs.find(t => pinnedStatesById?.[t.id]?.bookmarkId === item.id);
                            const byExactUrl = BookmarkUtils.findTabByUrl(tabs, item.url);
                            const byBaseUrl = tabs.find(t =>
                                t?.id &&
                                !representedPinnedTabIds.has(t.id) &&
                                Utils.getPinnedUrlKey(t.url) === Utils.getPinnedUrlKey(item.url)
                            );
                            const existingTab = byBookmarkId || byExactUrl || byBaseUrl;
                            if (existingTab) {
                                Logger.log('Creating UI element for active bookmark:', existingTab);
                                representedPinnedTabIds.add(existingTab.id);
                                existingTab.pinnedUrl = item.url;
                                existingTab.bookmarkId = item.id;
                                const tabElement = await createTabElement(existingTab, true);
                                Logger.log('Appending tab element to container:', tabElement);
                                container.appendChild(tabElement);
                            } else {
                                // Create UI element for inactive bookmark
                                const bookmarkTab = {
                                    id: null,
                                    title: item.title,
                                    url: item.url,
                                    favIconUrl: null,
                                    sidebarName: state.name,
                                    pinnedUrl: item.url,
                                    bookmarkId: item.id
                                };
                                Logger.log('Creating UI element for inactive bookmark:', item);
                                const tabElement = await createTabElement(bookmarkTab, true, true);
                                container.appendChild(tabElement);
                            }
                            processedUrls.add(item.url);
                            // Update placeholder state for folder if this container is inside a folder
                            const parentFolder = container.closest('.folder');
                            if (parentFolder) {
                                updateFolderPlaceholder(parentFolder);
                            }
                        }
                    }
                }
                return;
            }

            // Process the Arcify bookmark tree and get all bookmarked URLs
            await processBookmarkNode(collectionFolder, pinnedContainer);
        }


        // Load temporary tabs
        let tabsToLoad = [...state.temporaryTabs];

        if (invertTabOrder) {
            tabsToLoad.reverse();
        }

        tabsToLoad.forEach(async tabId => {
            Logger.log("checking", tabId, sidebarState);
            const tab = tabs.find(t => t.id === tabId);
            const representedAsPinned = representedPinnedTabIds.has(tabId);
            Logger.log("representedAsPinned", representedAsPinned);

            if (tab && !representedAsPinned) {
                const tabElement = await createTabElement(tab);
                tempContainer.appendChild(tabElement);
            }
        });
    } catch (error) {
        Logger.error('Error loading tabs:', error);
    }
}

// Debounced UI refresh when settings change (e.g., invertTabOrder)
let refreshSidebarUITimeout = null;

async function refreshSidebarUI() {
    try {
        if (!sidebarState) return;

        const sidebarView = document.querySelector('.sidebar-view');
        if (!sidebarView) return;

        const pinnedContainer = sidebarView.querySelector('[data-tab-type="pinned"]');
        const tempContainer = sidebarView.querySelector('[data-tab-type="temporary"]');
        if (!pinnedContainer || !tempContainer) return;

        // Clear existing rendered elements but keep templates (e.g., #folderTemplate).
        pinnedContainer.querySelectorAll('.tab, .folder').forEach(el => el.remove());
        tempContainer.querySelectorAll('.tab').forEach(el => el.remove());

        await loadTabs(sidebarState, pinnedContainer, tempContainer);
        updatePinnedSectionPlaceholders();

        // Restore active highlight if possible
        const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTabs?.length) {
            activateTabInDOM(activeTabs[0].id);
        }
    } catch (e) {
        Logger.warn('[UIRefresh] Error refreshing sidebar UI:', e);
    }
}

// Function to update chevron state based on pinned section visibility
function updateChevronState(sidebarView, pinnedContainer) {
    const chevronButton = sidebarView.querySelector('.sidebar-toggle-chevron');
    const isCollapsed = pinnedContainer.classList.contains('collapsed');
    if (!chevronButton) {
        return;
    }

    if (isCollapsed) {
        chevronButton.classList.add('collapsed');
    } else {
        chevronButton.classList.remove('collapsed');
    }
}

async function ensureFallbackTabBeforeClose(tabId) {
    const currentTabs = await chrome.tabs.query({ currentWindow: true });
    const isLastLiveTab = currentTabs.length === 1 && currentTabs[0]?.id === tabId;
    if (!isLastLiveTab) {
        return null;
    }

    return chrome.tabs.create({ active: true });
}

async function closeTab(tabElement, tab, isPinned = false, isBookmarkOnly = false) {
    Logger.log('Closing tab:', tab, tabElement, isPinned, isBookmarkOnly);

    if (isBookmarkOnly) {
        // Remove from bookmarks
        const bookmarkRoot = await getBookmarkRootFolder();
        await BookmarkUtils.removeBookmarkByUrl(bookmarkRoot.id, tab.url, {
            removeTabElement: true,
            tabElement: tabElement,
            logRemoval: true
        });

        // Update folder placeholders after removing bookmark
        updatePinnedSectionPlaceholders();
        return;
    }

    // If last tab is closed, create a new empty tab to prevent tab group from closing
    Logger.log("sidebarState", sidebarState);
    const isCurrentlyPinned = sidebarState?.pinnedTabIds.includes(tab.id);
    const isCurrentlyTemporary = sidebarState?.temporaryTabs.includes(tab.id);
    Logger.log("isCurrentlyPinned", isCurrentlyPinned, "isCurrentlyTemporary", isCurrentlyTemporary, "isPinned", isPinned);
    if (isCurrentlyPinned || (isPinned && !isCurrentlyTemporary)) {
        Logger.log("tab", tab);

        const overrides = await Utils.getTabNameOverrides();
        const override = overrides[tab.id];
        const displayTitle = override ? override.name : tab.title;

        const bookmarkTab = {
            id: null,
            title: displayTitle,
            url: tab.url,
            favIconUrl: tab.favIconUrl,
            sidebarName: tab.sidebarName
        };
        const parentFolder = tabElement.closest('.folder');
        const inactiveTabElement = await createTabElement(bookmarkTab, true, true);
        tabElement.replaceWith(inactiveTabElement);
        if (parentFolder) syncCollapsedFolderTabs(parentFolder);

        await ensureFallbackTabBeforeClose(tab.id);
        chrome.tabs.remove(tab.id);

        const sidebarView = document.querySelector('.sidebar-view');
        if (sidebarView) {
            const pinnedContainer = sidebarView.querySelector('[data-tab-type="pinned"]');
            updateChevronState(sidebarView, pinnedContainer);
        }
        return;
    } else {
        await ensureFallbackTabBeforeClose(tab.id);
        chrome.tabs.remove(tab.id);
    }

    // Update chevron state after closing any tab
    const sidebarView = document.querySelector('.sidebar-view');
    if (sidebarView) {
        const pinnedContainer = sidebarView.querySelector('[data-tab-type="pinned"]');
        updateChevronState(sidebarView, pinnedContainer);
    }
}

async function createTabElement(tab, isPinned = false, isBookmarkOnly = false) {
    Logger.log('Creating tab element:', tab.id, 'IsBookmarkOnly:', isBookmarkOnly);

    // Get the template and clone it
    const template = document.getElementById('tabTemplate');
    const tabElement = template.content.cloneNode(true).querySelector('.tab');

    // Set up the tab element properties
    tabElement.draggable = true; // Enable dragging for all tabs (regular and bookmark-only)

    if (isBookmarkOnly) {
        tabElement.classList.add('inactive', 'bookmark-only');
        tabElement.dataset.url = tab.url;
        if (tab.pinnedUrl) tabElement.dataset.pinnedUrl = tab.pinnedUrl;
        if (tab.bookmarkId) tabElement.dataset.bookmarkId = tab.bookmarkId;
    } else {
        tabElement.dataset.tabId = tab.id;
        tabElement.dataset.url = tab.url;
        if (tab.active) {
            tabElement.classList.add('active');
        }
    }

    // Get references to template elements
    const favicon = tabElement.querySelector('.tab-favicon');
    const tabDetails = tabElement.querySelector('.tab-details');
    const titleDisplay = tabElement.querySelector('.tab-title-display');
    const domainDisplay = tabElement.querySelector('.tab-domain-display');
    const titleInput = tabElement.querySelector('.tab-title-input');
    const actionButton = tabElement.querySelector('.tab-close');

    // Arc-like visual indicator: "/" shown next to favicon when pinned URL has changed.
    let urlChangedSlash = tabElement.querySelector('.tab-url-changed-slash');
    if (!urlChangedSlash) {
        urlChangedSlash = document.createElement('span');
        urlChangedSlash.className = 'tab-url-changed-slash';
        urlChangedSlash.textContent = '/';
        favicon.insertAdjacentElement('afterend', urlChangedSlash);
    }

    // Track pinned URL + bookmarkId for Arc-like behavior on active pinned tabs.
    let pinnedUrlForTab = null;
    if (isPinned && !isBookmarkOnly && tab?.id) {
        const stored = await Utils.getPinnedTabState(tab.id);
        pinnedUrlForTab = tab.pinnedUrl || stored?.pinnedUrl || tab.url;
        const bookmarkIdForTab = tab.bookmarkId || stored?.bookmarkId || null;
        tabElement.dataset.pinnedUrl = pinnedUrlForTab;
        if (bookmarkIdForTab) tabElement.dataset.bookmarkId = bookmarkIdForTab;
        await Utils.setPinnedTabState(tab.id, { pinnedUrl: pinnedUrlForTab, bookmarkId: bookmarkIdForTab });
    }

    // Set up favicon
    favicon.src = Utils.getFaviconUrl(tab.url);
    favicon.classList.add('tab-favicon');
    favicon.onerror = () => {
        favicon.src = tab.favIconUrl;
        favicon.onerror = () => { favicon.src = 'assets/default_icon.png'; }; // Fallback favicon
    }; // Fallback favicon

    // Arc-like: clicking the favicon takes you back to the pinned URL (if navigated away).
    if (isPinned && !isBookmarkOnly) {
        const computePinnedUrl = async () => {
            const stored = tab?.id ? await Utils.getPinnedTabState(tab.id) : null;
            return tabElement.dataset.pinnedUrl || tab.pinnedUrl || stored?.pinnedUrl || tab.url || null;
        };

        // IMPORTANT: always prefer the dataset URL (kept fresh by handleTabUpdate) over the captured `tab.url`
        // to avoid stale comparisons after navigation.
        const computeCurrentUrl = () => tabElement.dataset.url || tab.url || null;

        const canBackToPinned = async () => {
            const pinnedUrl = await computePinnedUrl();
            const currentUrl = computeCurrentUrl();
            return Boolean(pinnedUrl && currentUrl && Utils.getPinnedUrlKey(currentUrl) !== Utils.getPinnedUrlKey(pinnedUrl));
        };

        const setBackButtonState = async () => {
            const enabled = await canBackToPinned();
            favicon.classList.toggle('pinned-back', enabled);
            favicon.title = enabled ? 'Back to Pinned URL' : '';
            urlChangedSlash.classList.toggle('visible', enabled);
        };

        await setBackButtonState();

        favicon.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!tab?.id) return;
            try {
                const pinnedUrl = await computePinnedUrl();
                if (!pinnedUrl) return;
                const current = await chrome.tabs.get(tab.id);
                if (!current?.url || current.url === pinnedUrl) return;
                await chrome.tabs.update(tab.id, { url: pinnedUrl, active: true });
            } catch (err) {
                Logger.warn('[PinnedTab] Failed to navigate back to pinned URL:', err);
            }
        });
    }

    // Set up action button
    actionButton.classList.remove('tab-close');
    actionButton.classList.add(isBookmarkOnly ? 'tab-remove' : 'tab-close');
    actionButton.innerHTML = isBookmarkOnly ? '×' : (isPinned ? '−' : '×');
    actionButton.title = isBookmarkOnly ? 'Remove Bookmark' : 'Close Tab';
    actionButton.addEventListener('click', async (e) => {
        e.stopPropagation();
        Logger.log("sidebarState", sidebarState);
        const isCurrentlyPinned = sidebarState?.pinnedTabIds.includes(tab.id);
        closeTab(tabElement, tab, isCurrentlyPinned, isBookmarkOnly);
    });

    // --- Function to update display based on overrides ---
    const updateDisplay = async () => {
        // For bookmark-only elements, just display the stored title
        if (isBookmarkOnly) {
            titleDisplay.textContent = tab.title || 'Bookmark'; // Use stored title
            titleDisplay.style.display = 'inline';
            titleInput.style.display = 'none';
            domainDisplay.style.display = 'none';
            return;
        }

        // For actual tabs, check overrides
        const overrides = await Utils.getTabNameOverrides();
        const override = overrides[tab.id];
        let displayTitle = tab.title; // Default to actual tab title
        let displayDomain = null;

        titleInput.value = tab.title; // Default input value is current tab title

        // For pinned tabs: only force the bookmark/override title when we're still on the pinned URL.
        // If the tab navigates away, show the real page title (Arc-like).
        const pinnedUrl = (isPinned ? (tabElement.dataset.pinnedUrl || pinnedUrlForTab) : null);
        const isNavigatedAway = Boolean(isPinned && pinnedUrl && tab.url && Utils.getPinnedUrlKey(tab.url) !== Utils.getPinnedUrlKey(pinnedUrl));

        if (override && !isNavigatedAway) {
            displayTitle = override.name;
            titleInput.value = override.name; // Set input value to override name
        }

        // Domain subtitle: only show when navigated away from the pinned domain.
        if (isPinned && pinnedUrl && tab.url && Utils.getPinnedUrlKey(tab.url) !== Utils.getPinnedUrlKey(pinnedUrl)) {
            try {
                const pinnedDomain = new URL(pinnedUrl).hostname;
                const currentDomain = new URL(tab.url).hostname;
                if (currentDomain && pinnedDomain && currentDomain !== pinnedDomain) {
                    displayDomain = currentDomain;
                }
            } catch (e) {
                Logger.warn("Error parsing URL for domain check:", tab.url, e);
            }
        }

        titleDisplay.textContent = displayTitle;
        if (displayDomain) {
            domainDisplay.textContent = displayDomain;
            domainDisplay.classList.remove('back-to-pinned');
            domainDisplay.style.display = 'block';
        } else {
            domainDisplay.classList.remove('back-to-pinned');
            domainDisplay.style.display = 'none';
        }

        // Ensure correct elements are visible
        titleDisplay.style.display = 'inline'; // Or 'block' if needed
        titleInput.style.display = 'none';
    };

    // --- Event Listeners for Editing (Only for actual tabs) ---
    if (!isBookmarkOnly) {
        tabDetails.addEventListener('dblclick', (e) => {
            // Prevent dblclick on favicon or close button from triggering rename
            if (e.target === favicon || e.target === actionButton) return;

            titleDisplay.style.display = 'none';
            domainDisplay.style.display = 'none'; // Hide domain while editing
            titleInput.style.display = 'inline-block'; // Or 'block'
            titleInput.select(); // Select text for easy replacement
            titleInput.focus(); // Focus the input
        });

        const saveOrCancelEdit = async (save) => {
            if (save) {
                const newName = titleInput.value.trim();
                try {
                    // Fetch the latest tab info in case the title changed naturally
                    const currentTabInfo = await chrome.tabs.get(tab.id);
                    const originalTitle = currentTabInfo.title;
                    if (newName && newName !== originalTitle) {
                        await Utils.setTabNameOverride(tab.id, tab.url, newName);
                        if (isPinned) {
                            await updateBookmarkForTab(tab, newName);
                        }
                    } else {
                        // If name is empty or same as original, remove override
                        await Utils.removeTabNameOverride(tab.id);
                        if (isPinned) {
                            await updateBookmarkForTab(tab, originalTitle);
                        }
                    }
                } catch (error) {
                    Logger.error("Error getting tab info or saving override:", error);
                    // Handle cases where the tab might have been closed during edit
                }
            }
            // Update display regardless of save/cancel to show correct state
            // Need to fetch tab again in case URL changed during edit? Unlikely but possible.
            try {
                const potentiallyUpdatedTab = await chrome.tabs.get(tab.id);
                tab.title = potentiallyUpdatedTab.title; // Update local tab object title
                tab.url = potentiallyUpdatedTab.url; // Update local tab object url
            } catch (e) {
                Logger.log("Tab likely closed during edit, cannot update display.");
                // If tab closed, the element will be removed by handleTabRemove anyway
                return;
            }
            await updateDisplay();
        };

        titleInput.addEventListener('blur', () => saveOrCancelEdit(true));
        titleInput.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter') {
                e.preventDefault(); // Prevent potential form submission if wrapped
                await saveOrCancelEdit(true);
                titleInput.blur(); // Explicitly blur to hide input
            } else if (e.key === 'Escape') {
                await saveOrCancelEdit(false); // Cancel reverts input visually via updateDisplay
                titleInput.blur(); // Explicitly blur to hide input
            }
        });
    }

    // --- Initial Display ---
    await updateDisplay(); // Call initially to set the correct title/domain


    // Handle mousedown events (left-click to open, middle-click to close)
    tabElement.addEventListener('mousedown', async (event) => {
        if (event.button === MOUSE_BUTTON.MIDDLE) {
            event.preventDefault(); // Prevent default middle-click actions (like autoscroll)
            closeTab(tabElement, tab, isPinned, isBookmarkOnly);
        } else if (event.button === MOUSE_BUTTON.LEFT) {
            // Don't activate tab when clicking close button
            if (event.target === actionButton) return;

            // Remove active class from all tabs and favicons
            clearAllActiveStates();

            let chromeTab = null;
            try {
                chromeTab = await chrome.tabs.get(tab.id);
            } catch (e) {
                Logger.log("Tab likely closed during archival.", e, tab);
            }

            if (isBookmarkOnly || !chromeTab) {
                Logger.log('Opening bookmark:', tab);
                isOpeningBookmark = true; // Set flag
                try {
                    // Get URL from dataset if tab object doesn't have it (archived tab case)
                    const tabUrl = tab.url || tabElement.dataset.url;
                    if (!tabUrl) {
                        Logger.error("Cannot open bookmark: No URL found for archived tab.");
                        isOpeningBookmark = false;
                        return;
                    }

                    // Check if tab exists by URL (might be open but in different window/state)
                    const allTabs = await chrome.tabs.query({});
                    const existingTab = BookmarkUtils.findTabByUrl(allTabs, tabUrl);

                    if (existingTab) {
                        // Tab exists, just activate it
                        Logger.log('Found existing tab with same URL, activating:', existingTab.id);
                        chrome.tabs.update(existingTab.id, { active: true });
                        activateTabInDOM(existingTab.id);

                        if (isPinned) {
                            const pinnedUrl = tabElement.dataset.pinnedUrl || tabUrl;
                            const bookmarkId = tabElement.dataset.bookmarkId || null;
                            await Utils.setPinnedTabState(existingTab.id, { pinnedUrl: pinnedUrl, bookmarkId: bookmarkId });
                        }

                        // Update sidebar state if needed
                        if (sidebarOwnsTab(existingTab)) {
                            sidebarState.lastTab = existingTab.id;
                            if (isPinned && !sidebarState.pinnedTabIds.includes(existingTab.id)) {
                                sidebarState.pinnedTabIds.push(existingTab.id);
                            }
                            saveSidebarState();
                        }

                        // Replace the element with the active tab element
                        const updatedTabElement = await createTabElement(existingTab, isPinned, false);
                        tabElement.replaceWith(updatedTabElement);
                        isOpeningBookmark = false;
                        return;
                    }

                    // Check if tab is in archive and restore it
                    const archivedTabs = await Utils.getArchivedTabs();
                    const archivedTab = archivedTabs.find(t => t.url === tabUrl);

                    let bookmarkTitle = tab.title || tabElement.querySelector('.tab-title-display')?.textContent || 'Bookmark';

                    if (archivedTab) {
                        Logger.log('Found archived tab, restoring from archive:', archivedTab);
                        bookmarkTitle = archivedTab.name || bookmarkTitle;

                        // Restore the archived tab
                        const restoredTab = await Utils.restoreArchivedTab(archivedTab);

                        if (restoredTab) {
                            // Pin the restored tab if it was originally pinned
                            if (isPinned) {
                                await chrome.tabs.update(restoredTab.id, { pinned: true });
                            }

                            // Tab is already active from restore, but ensure it's activated
                            chrome.tabs.update(restoredTab.id, { active: true });
                            activateTabInDOM(restoredTab.id);

                            // Update sidebar state
                            if (sidebarState) {
                                sidebarState.lastTab = restoredTab.id;
                                if (isPinned) {
                                    if (tab.id) {
                                        sidebarState.pinnedTabIds = sidebarState.pinnedTabIds.filter(id => id !== tab.id);
                                    }
                                    if (!sidebarState.pinnedTabIds.includes(restoredTab.id)) {
                                        sidebarState.pinnedTabIds.push(restoredTab.id);
                                    }
                                }
                                saveSidebarState();
                            }

                            await reconcileTabOrdering({ source: 'arcify', movedTabId: restoredTab.id });

                            // Replace the element with the active tab element
                            if (isPinned) {
                                const pinnedUrl = tabElement.dataset.pinnedUrl || tabUrl;
                                const bookmarkId = tabElement.dataset.bookmarkId || null;
                                restoredTab.pinnedUrl = pinnedUrl;
                                restoredTab.bookmarkId = bookmarkId;
                                await Utils.setPinnedTabState(restoredTab.id, { pinnedUrl: pinnedUrl, bookmarkId: bookmarkId });
                            }
                            const updatedTabElement = await createTabElement(restoredTab, isPinned, false);
                            tabElement.replaceWith(updatedTabElement);
                            isOpeningBookmark = false;
                            return;
                        }
                    }

                    // Tab not found and not in archive, open as new bookmark
                    if (!sidebarState) {
                        Logger.error("Cannot open bookmark: Sidebar state not initialized.");
                        isOpeningBookmark = false;
                        return;
                    }

                    if (!tab.sidebarName) {
                        tab.sidebarName = sidebarState.name;
                    }

                    const bookmarkData = {
                        url: tabUrl,
                        title: bookmarkTitle,
                        sidebarName: tab.sidebarName || sidebarState.name,
                        pinnedUrl: tabElement.dataset.pinnedUrl || tabUrl,
                        bookmarkId: tabElement.dataset.bookmarkId || null
                    };

                    const context = {
                        sidebarState,
                        currentWindow,
                        saveSidebarState,
                        createTabElement,
                        activateTabInDOM,
                        Utils
                    };

                    await BookmarkUtils.openBookmarkAsTab(bookmarkData, tabElement, context, isPinned);

                } catch (error) {
                    Logger.error("Error opening bookmark:", error);
                } finally {
                    isOpeningBookmark = false; // Reset flag
                }
            } else {
                // It's a regular tab, just activate it
                tabElement.classList.add('active');
                chrome.tabs.update(tab.id, { active: true });
                if (sidebarOwnsTab(tab)) {
                    sidebarState.lastTab = tab.id;
                    saveSidebarState();
                }
            }
        }
    });

    // Set up drag handlers for all tabs (regular and bookmark-only)
    setupTabDragHandlers(tabElement);

    // --- Context Menu ---
    tabElement.addEventListener('contextmenu', async (e) => {
        e.preventDefault();
        showTabContextMenu(
            e.pageX,
            e.pageY,
            tab,
            isPinned,
            isBookmarkOnly,
            tabElement,
            closeTab,
            replaceBookmarkUrlWithCurrentUrl
        );
    });

    return tabElement;
}

async function handlePinnedStateChange(tabId, tab, tabElement, isPinnedNow) {
    if (isPinnedNow) {
        const stateWithTab = sidebarOwnsTab(tabId) ? sidebarState : null;

        if (stateWithTab && stateWithTab.pinnedTabIds.includes(tabId)) {
            const bookmarkRoot = await getBookmarkRootFolder();
            await BookmarkUtils.removeBookmarkByUrl(bookmarkRoot.id, tab.url);
        }

        if (sidebarState) {
            sidebarState.pinnedTabIds = sidebarState.pinnedTabIds.filter(id => id !== tabId);
            sidebarState.temporaryTabs = sidebarState.temporaryTabs.filter(id => id !== tabId);
        }
        await Utils.removePinnedTabState(tabId);
        saveSidebarState();
        tabElement.remove();
        return;
    }

    moveTabInSidebar(tabId, false);
}

async function refreshTabTextDisplay(tabId, tab, tabElement) {
    const titleDisplay = tabElement.querySelector('.tab-title-display');
    const domainDisplay = tabElement.querySelector('.tab-domain-display');
    const titleInput = tabElement.querySelector('.tab-title-input');

    if (!titleDisplay || !domainDisplay || !titleInput || document.activeElement === titleInput) {
        return;
    }

    const overrides = await Utils.getTabNameOverrides();
    const override = overrides[tabId];
    let displayTitle = tab.title;
    let displayDomain = null;
    const pinnedUrl = tabElement.dataset.pinnedUrl || (await Utils.getPinnedTabState(tabId))?.pinnedUrl || null;
    const isNavigatedAway = Boolean(pinnedUrl && tab.url && Utils.getPinnedUrlKey(tab.url) !== Utils.getPinnedUrlKey(pinnedUrl));

    if (override && !isNavigatedAway) {
        displayTitle = override.name;
    }

    titleDisplay.textContent = displayTitle;

    if (isNavigatedAway) {
        try {
            const pinnedDomain = new URL(pinnedUrl).hostname;
            const currentDomain = new URL(tab.url).hostname;
            if (currentDomain && pinnedDomain && currentDomain !== pinnedDomain) {
                displayDomain = currentDomain;
            }
        } catch (e) {
            // Ignore invalid URLs.
        }
    }

    if (displayDomain) {
        domainDisplay.textContent = displayDomain;
        domainDisplay.style.display = 'block';
    } else {
        domainDisplay.style.display = 'none';
    }

    titleInput.value = (override && !isNavigatedAway) ? override.name : tab.title;
}

async function refreshTabFavicon(tabId, tab, changeInfo, tabElement) {
    let faviconElement = tabElement.querySelector('.tab-favicon');
    if (!faviconElement) {
        faviconElement = tabElement.querySelector('img');
    }

    if (!faviconElement) {
        Logger.log('No favicon element found', faviconElement, tabElement);
        return;
    }

    if (changeInfo.url || changeInfo.favIconUrl) {
        faviconElement.src = tab.favIconUrl;
        faviconElement.onerror = () => {
            faviconElement.src = tab.favIconUrl;
            faviconElement.onerror = () => { faviconElement.src = 'assets/default_icon.png'; };
        };
    }

    if (!changeInfo.url) {
        return;
    }

    faviconElement.src = Utils.getFaviconUrl(changeInfo.url);
    tabElement.dataset.url = tab.url;

    if (!tabElement.closest('[data-tab-type="pinned"]')) {
        return;
    }

    const pinnedUrl = tabElement.dataset.pinnedUrl || (await Utils.getPinnedTabState(tabId))?.pinnedUrl;
    const shouldEnableBack = Boolean(pinnedUrl && tab.url && Utils.getPinnedUrlKey(tab.url) !== Utils.getPinnedUrlKey(pinnedUrl));
    faviconElement.classList.toggle('pinned-back', shouldEnableBack);
    faviconElement.title = shouldEnableBack ? 'Back to Pinned URL' : '';
    const slash = tabElement.querySelector('.tab-url-changed-slash');
    if (slash) slash.classList.toggle('visible', shouldEnableBack);
}

function handleTabUpdateSideEffects(tabId, changeInfo) {
    if (changeInfo.active !== undefined && changeInfo.active) {
        activateTabInDOM(tabId);
    }
    if (changeInfo.status == 'complete' || changeInfo.status == 'loading') {
        scrollToTab(tabId, 100);
    }
}

function handleTabCreated(tab) {
    if (isOpeningBookmark) {
        Logger.log('Skipping tab creation handler - bookmark is being opened');
        return;
    }
    chrome.windows.getCurrent({ populate: false }, async (currentWindow) => {
        if (tab.windowId !== currentWindow.id) {
            Logger.log('New tab is in a different window, ignoring...');
            return;
        }

        Logger.log('Tab created:', tab);
        chrome.tabs.query({ active: true, currentWindow: true }, async () => {
            try {
                if (sidebarState) {
                    await moveTabInSidebar(tab.id, false, tab.openerTabId);
                }
            } catch (error) {
                Logger.error('Error handling new tab:', error);
            }
        });
    });
}


function handleTabUpdate(tabId, changeInfo, tab) {
    if (isOpeningBookmark) {
        return;
    }
    chrome.windows.getCurrent({ populate: false }, async (currentWindow) => {
        if (tab.windowId !== currentWindow.id) {
            Logger.log('New tab is in a different window, ignoring...');
            return;
        }
        Logger.log('Tab updated:', tabId, changeInfo, sidebarState);

        const tabElement = document.querySelector(`[data-tab-id="${tabId}"]`);
        if (!tabElement) {
            return;
        }

        if (changeInfo.pinned !== undefined) {
            await handlePinnedStateChange(tabId, tab, tabElement, changeInfo.pinned);
            updatePinnedFavicons();
            return;
        }

        await refreshTabTextDisplay(tabId, tab, tabElement);
        await refreshTabFavicon(tabId, tab, changeInfo, tabElement);
        handleTabUpdateSideEffects(tabId, changeInfo);
    });
}

async function handleTabRemove(tabId) {
    Logger.log('Tab removed:', tabId);
    await Utils.removePinnedTabState(tabId);
    // Get tab element before removing it
    const tabElement = document.querySelector(`[data-tab-id="${tabId}"]`);
    if (!tabElement) return;
    Logger.log("tabElement", tabElement);

    // Clean up the tabId from collapsedFolderShownTabs to prevent memory leaks from stale IDs.
    const parentFolder = tabElement.closest('.folder');
    if (parentFolder) {
        const shownTabIds = collapsedFolderShownTabs.get(parentFolder);
        if (shownTabIds) {
            shownTabIds.delete(tabId);
        }
    }
    Logger.log("sidebarState", sidebarState);
    const isPinned = sidebarState?.pinnedTabIds.find(id => id === tabId) != null;
    Logger.log("isPinned", isPinned);

    if (isPinned) {
        // For pinned tabs, convert to bookmark-only element using existing bookmark data
        try {
            // Find the bookmark in Chrome bookmarks
            const bookmarkRoot = await getBookmarkRootFolder();

            if (bookmarkRoot) {
                // Try to get tab URL from Chrome API first, then fall back to DOM extraction
                let tabUrl;
                try {
                    const tabData = await chrome.tabs.get(tabId);
                    tabUrl = tabData.url;
                    Logger.log('Found tab URL from Chrome API:', tabUrl);
                } catch (error) {
                    // Tab already closed, try to extract URL from DOM or other means
                    Logger.log('Tab already closed, unable to get URL from Chrome API');
                }

                // Fallback: Extract URL from bookmark-only element's dataset if Chrome API failed
                if (!tabUrl && tabElement) {
                    Logger.log('!!!!!!!! TAB ELEMENT', tabElement);
                    if (tabElement.dataset.url) {
                        tabUrl = tabElement.dataset.url;
                        Logger.log('Extracted URL from bookmark-only element dataset:', tabUrl);
                    } else if (tabElement.classList.contains('bookmark-only')) {
                        Logger.log('Bookmark-only element found but no URL in dataset - this should not happen');
                    } else {
                        Logger.log('Real tab element found but Chrome API failed - tab may have been closed very recently');
                    }
                }

                // Use recursive search to find bookmark in the Arcify bookmark tree
                let matchingBookmark = null;
                if (tabUrl) {
                    Logger.log('Searching for bookmark recursively with URL:', tabUrl);
                    let bookmarkResult = await BookmarkUtils.findBookmarkInFolderRecursive(bookmarkRoot.id, { url: tabUrl });
                    Logger.log('Bookmark search result:', bookmarkResult);
                    matchingBookmark = bookmarkResult?.bookmark;
                }

                // If URL search failed, try fallback search by title (less reliable)
                if (!matchingBookmark) {
                    Logger.log('URL search failed, attempting fallback title search');
                    const titleElement = tabElement.querySelector('.tab-title-display, .tab-details span');
                    const titleText = titleElement?.textContent;

                    if (titleText) {
                        Logger.log('Searching for bookmark recursively with title:', titleText);
                        let bookmarkResult = await BookmarkUtils.findBookmarkInFolderRecursive(bookmarkRoot.id, { title: titleText });
                        Logger.log('Title search result:', bookmarkResult);
                        matchingBookmark = bookmarkResult?.bookmark;
                    }
                }

                if (matchingBookmark) {
                    // Use the established pattern from loadTabs()
                    const bookmarkTab = {
                        id: null,
                        title: matchingBookmark.title,
                        url: matchingBookmark.url,
                        favIconUrl: null,
                        sidebarName: sidebarState?.name
                    };
                    const bookmarkElement = await createTabElement(bookmarkTab, true, true);

                    // Preserve folder context - replace in the same DOM location
                    const parentFolder = tabElement.closest('.folder');
                    tabElement.replaceWith(bookmarkElement);
                    if (parentFolder) syncCollapsedFolderTabs(parentFolder);

                    // Update folder placeholder state if the tab was in a folder
                    if (parentFolder) {
                        Logger.log('Updated folder placeholder state after tab-to-bookmark conversion');
                        updateFolderPlaceholder(parentFolder);
                    }

                    Logger.log('Successfully converted closed pinned tab to bookmark-only element in', parentFolder ? 'folder' : 'root level');
                } else {
                    Logger.warn('Could not find matching bookmark for closed pinned tab, removing element');
                    tabElement.remove();
                }
            } else {
                Logger.warn('Could not find Arcify bookmark root for closed pinned tab, removing element');
                tabElement.remove();
            }
        } catch (error) {
            Logger.error('Error converting pinned tab to bookmark-only element:', error);
            // Fallback: just remove the element
            tabElement.remove();
        }
    } else {
        // If not a pinned tab, remove the element
        tabElement?.remove();
    }

    if (sidebarState) {
        sidebarState.pinnedTabIds = sidebarState.pinnedTabIds.filter(id => id !== tabId);
        sidebarState.temporaryTabs = sidebarState.temporaryTabs.filter(id => id !== tabId);
    }

    saveSidebarState();

    // Update pinned favicons to show/hide placeholder when last pinned tab is removed
    updatePinnedFavicons();
}

// Track pending tab moves to debounce rapid successive moves
const pendingTabMoves = new Map();
const processingTabMoves = new Set();

function handleTabMove(tabId, moveInfo) {
    if (isOpeningBookmark) {
        return;
    }

    // If we're already processing a move for this tab, ignore new events
    if (processingTabMoves.has(tabId)) {
        Logger.log('[TabMove] ⚠️ Ignoring move event - already processing tab', tabId, 'toIndex:', moveInfo.toIndex);
        return;
    }

    // Store the latest move info for this tab
    const existingData = pendingTabMoves.get(tabId);
    if (existingData) {
        clearTimeout(existingData.timeoutId);
        Logger.log('[TabMove] 🔄 Updating pending move for tab', tabId, '- Old toIndex:', existingData.moveInfo.toIndex, 'New toIndex:', moveInfo.toIndex);
    } else {
        Logger.log('[TabMove] 📝 New move event for tab', tabId, 'toIndex:', moveInfo.toIndex);
    }

    // Debounce: wait 250ms before processing the move
    // This ensures we only process after all rapid events have finished
    const timeoutId = setTimeout(async () => {
        const data = pendingTabMoves.get(tabId);
        if (data) {
            Logger.log('[TabMove] ✅ Processing final move for tab', tabId, 'toIndex:', data.moveInfo.toIndex);
            pendingTabMoves.delete(tabId);
            processingTabMoves.add(tabId);
            await processTabMove(tabId, data.moveInfo);
            processingTabMoves.delete(tabId);
            Logger.log('[TabMove] ✅ Finished processing tab', tabId);
        }
    }, 250);

    pendingTabMoves.set(tabId, { moveInfo, timeoutId });
}

async function processTabMove(tabId, moveInfo) {
    chrome.windows.getCurrent({ populate: false }, async (currentWindow) => {
        // Get the tab's current information first
        chrome.tabs.get(tabId, async (tab) => {
            if (tab.windowId !== currentWindow.id) {
                Logger.log('[TabMove] New tab is in a different window, ignoring...');
                return;
            }
            Logger.log('[TabMove] Tab moved:', tabId, moveInfo);

            if (!sidebarState) return;

            const currentTabs = await chrome.tabs.query({ currentWindow: true });
            const pinnedSet = new Set(sidebarState.pinnedTabIds ?? []);
            sidebarState.temporaryTabs = currentTabs
                .filter(t => !t.pinned && !pinnedSet.has(t.id))
                .map(t => t.id);
            saveSidebarState();
        });
    });
}

function handleTabActivated(activeInfo) {
    chrome.windows.getCurrent({ populate: false }, async (currentWindow) => {
        if (activeInfo.windowId !== currentWindow.id) {
            Logger.log('New tab is in a different window, ignoring...');
            return;
        }

        Logger.log('Tab activated:', activeInfo);
        activeChromeTabId = activeInfo.tabId;
        const stateWithTab = sidebarOwnsTab(activeInfo.tabId) ? sidebarState : null;
        Logger.log("stateWithTab", stateWithTab);

        if (stateWithTab) {
            stateWithTab.lastTab = activeInfo.tabId;
            saveSidebarState();
            Logger.log("updated last active tab", stateWithTab.lastTab);
        }

        activateTabInDOM(activeInfo.tabId);

        // Arc-like behavior: if this tab is inside a collapsed folder, add it to the folder's shown tabs set.
        // This makes the tab stay visible in the collapsed folder until user manually opens/closes the folder.
        if (!showAllOpenTabsInCollapsedFolders) {
            const tabElement = document.querySelector(`.tab[data-tab-id="${activeInfo.tabId}"]`);
            if (tabElement) {
                const parentFolder = tabElement.closest('.folder');
                if (parentFolder && parentFolder.classList.contains('collapsed')) {
                    let shownTabIds = collapsedFolderShownTabs.get(parentFolder);
                    if (!shownTabIds) {
                        shownTabIds = new Set();
                        collapsedFolderShownTabs.set(parentFolder, shownTabIds);
                    }
                    shownTabIds.add(activeInfo.tabId);
                }
            }
        }

        // Update collapsed-folder projections to follow Arc behavior (active-only) unless user enabled "show all open".
        syncCollapsedFolders();

        // Scroll to the activated tab's location
        scrollToTab(activeInfo.tabId, 0);
    });
}

////////////////////////////////////////////////////////////////
// -- Helper Functions
////////////////////////////////////////////////////////////////

/**
 * Scrolls to make a tab visible in the sidebar
 * @param {number} tabId - The ID of the tab to scroll to
 * @param {number} timeout - Timeout in milliseconds to wait before scrolling
 */
function scrollToTab(tabId, timeout = 0) {
    setTimeout(() => {
        const tabElement = document.querySelector(`[data-tab-id="${tabId}"]`);
        if (tabElement) {
            const sidebarView = tabElement.closest('.sidebar-view');
            if (sidebarView) {
                const sidebarContent = sidebarView.querySelector('.sidebar-content');
                if (sidebarContent) {
                    const tabRect = tabElement.getBoundingClientRect();
                    const sidebarContentRect = sidebarContent.getBoundingClientRect();

                    const isTabVisible = tabRect.top >= sidebarContentRect.top && tabRect.bottom <= sidebarContentRect.bottom;

                    if (!isTabVisible) {
                        Logger.log('[ScrollDebug] Scrolling to show tab');
                        const scrollTop = sidebarContent.scrollTop + (tabRect.top - sidebarContentRect.top);
                        sidebarContent.scrollTop = scrollTop;
                    } else {
                        Logger.log('[ScrollDebug] Tab is already visible, no scroll needed');
                    }
                } else {
                    Logger.log('[ScrollDebug] Collection content not found, no scroll needed');
                }
            } else {
                Logger.log('[ScrollDebug] Collection not found, no scroll needed');
            }
        } else {
            Logger.log('[ScrollDebug] Tab not found, no scroll needed');
        }
    }, timeout);
}

async function moveTabInSidebar(tabId, pinned = false, openerTabId = null) {
    processingTabMoves.add(tabId);
    if (!sidebarState) {
        Logger.warn('Sidebar state is not initialized.');
        processingTabMoves.delete(tabId);
        return;
    }

    sidebarState.pinnedTabIds = sidebarState.pinnedTabIds.filter(id => id !== tabId);
    sidebarState.temporaryTabs = sidebarState.temporaryTabs.filter(id => id !== tabId);
    sidebarState.lastTab = tabId;

    if (pinned) {
        sidebarState.pinnedTabIds.push(tabId);
    } else {
        sidebarState.temporaryTabs.push(tabId);
    }

    // 4. Update the UI (remove tab element from old section, create it in new section)
    // Remove any existing DOM element for this tab
    const oldTabElement = document.querySelector(`[data-tab-id="${tabId}"]`);
    oldTabElement?.remove();

    // Add a fresh tab element if needed
    const sidebarView = document.querySelector('.sidebar-view');
    if (sidebarView) {
        const containerSelector = pinned ? '[data-tab-type="pinned"]' : '[data-tab-type="temporary"]';
        const container = sidebarView.querySelector(containerSelector);

        const chromeTab = await chrome.tabs.get(tabId);
        const tabElement = await createTabElement(chromeTab, pinned);
        if (container.children.length > 1) {
            if (openerTabId) {
                let tabs = container.querySelectorAll(`.tab`);
                const openerTabIndex = Array.from(tabs).findIndex(tab => tab.dataset.tabId == openerTabId);
                if (openerTabIndex + 1 < tabs.length) {
                    const tabToInsertBefore = tabs[openerTabIndex + 1];
                    container.insertBefore(tabElement, tabToInsertBefore);
                } else {
                    container.appendChild(tabElement);
                }
            } else {
                if (pinned) {
                    // Add to the bottom after all existing elements
                    container.appendChild(tabElement);
                } else {
                    // For temporary tabs, sync with Chrome's tab order
                    const orderedTabs = (await chrome.tabs.query({ currentWindow: true })).filter(t => !t.pinned);
                    const currentTabIndex = orderedTabs.findIndex(t => t.id === tabId);

                    if (currentTabIndex !== -1 && orderedTabs.length > 1) {
                        // First, add the new tab element to the container so it can be found in the filter
                        container.appendChild(tabElement);

                        // Filter to only include tabs in the temporary container (including the new one)
                        const tabsInContainer = orderedTabs.filter(t => {
                            return container.querySelector(`[data-tab-id="${t.id}"]`);
                        });

                        // Apply invert order if enabled
                        const invertTabOrder = await Utils.getInvertTabOrder();
                        if (invertTabOrder) {
                            tabsInContainer.reverse();
                        }

                        // Re-append all tabs in correct order (including the new one)
                        tabsInContainer.forEach(t => {
                            const el = container.querySelector(`[data-tab-id="${t.id}"]`);
                            if (el) {
                                container.appendChild(el);
                            }
                        });
                    } else {
                        // Fallback: use simple insert logic
                        const invertTabOrder = await Utils.getInvertTabOrder();
                        if (invertTabOrder) {
                            container.insertBefore(tabElement, container.firstChild);
                        } else {
                            container.appendChild(tabElement);
                        }
                    }
                }
            }
        } else {
            container.appendChild(tabElement);
        }
    }

    saveSidebarState();
    processingTabMoves.delete(tabId);
}

// Reusable function to set up folder context menu
function setupFolderContextMenu(folderElement, _state, item = null) {
    folderElement.addEventListener('contextmenu', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const contextMenu = document.createElement('div');
        contextMenu.classList.add('context-menu');
        contextMenu.style.position = 'fixed';
        contextMenu.style.left = `${e.clientX}px`;
        contextMenu.style.top = `${e.clientY}px`;

        const deleteOption = document.createElement('div');
        deleteOption.classList.add('context-menu-item');
        deleteOption.textContent = 'Delete Folder';
        deleteOption.addEventListener('click', async () => {
            if (confirm('Are you sure you want to delete this folder and all its contents?')) {
                const collectionFolder = await getBookmarkRootFolder();
                if (collectionFolder) {
                    const folders = await chrome.bookmarks.getChildren(collectionFolder.id);
                    const folderTitle = item ? item.title : folderElement.querySelector('.folder-title').textContent;
                    const folder = folders.find(f => f.title === folderTitle);
                    if (folder) {
                        await chrome.bookmarks.removeTree(folder.id);
                        folderElement.remove();
                    }
                }
            }
            contextMenu.remove();
        });

        contextMenu.appendChild(deleteOption);
        document.body.appendChild(contextMenu);

        // Close context menu when clicking outside
        const closeContextMenu = (e) => {
            if (!contextMenu.contains(e.target)) {
                contextMenu.remove();
                document.removeEventListener('click', closeContextMenu);
            }
        };
        document.addEventListener('click', closeContextMenu);
    });
}
