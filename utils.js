/**
 * Utils - Shared utility functions and storage management
 * 
 * Purpose: Provides common utilities and centralized settings/storage management across the extension
 * Key Functions: Settings CRUD, archived tabs management, sidebar state operations, default configurations
 * Architecture: Static utility class with async storage operations
 * 
 * Critical Notes:
 * - Central source of truth for extension settings and defaults
 * - Handles both chrome.storage.sync (settings) and chrome.storage.local (sidebar/tab data)
 * - Used by both background script and UI components for consistent data access
 * - Settings changes automatically sync across extension contexts
 */

import { Logger } from './logger.js';

const MAX_ARCHIVED_TABS = 100;
const ARCHIVED_TABS_KEY = 'archivedTabs';
const SIDEBAR_STATE_KEY = 'sidebarState';
const MAIN_SIDEBAR_ID = 'main';

const Utils = {

    // Helper function to generate UUID (If you want to move this too)
    generateUUID: function () {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    },

    // Helper function to fetch favicon
    getFaviconUrl: function (u, size = "16") {
        const url = new URL(chrome.runtime.getURL("/_favicon/"));
        url.searchParams.set("pageUrl", u);
        url.searchParams.set("size", size);
        return url.toString();
    },

    // URL comparison key for pinned tabs:
    // intentionally ignore query params + hash to avoid treating benign changes (e.g. Google Docs) as "navigated away".
    getPinnedUrlKey: function (url) {
        if (!url) return '';
        try {
            const u = new URL(url);
            return `${u.origin}${u.pathname}`;
        } catch {
            // Fallback for non-standard URLs
            return String(url).split('#')[0].split('?')[0];
        }
    },

    getSettings: async function () {
        const defaultSettings = {
            autoArchiveEnabled: false, // Default: disabled
            autoArchiveIdleMinutes: 360, // Default: 30 minutes
            enableSpotlight: true, // Default: enabled (controls both spotlight and custom new tab)
            invertTabOrder: true, // Default: enabled (New tabs/High index on top)
            colorOverrides: null, // Default: no color overrides
            debugLoggingEnabled: false, // Default: disabled (controls debug logging)
            showAllOpenTabsInCollapsedFolders: false, // Default: Arc behavior (only show active tab in collapsed folder)
            // ... other settings ...
        };
        const result = await chrome.storage.sync.get(defaultSettings);
        Logger.log("Retrieved settings:", result);
        return result;
    },

    getDefaultSidebarState: async function () {
        const defaultName = 'Home';
        return {
            id: MAIN_SIDEBAR_ID,
            uuid: this.generateUUID(),
            name: defaultName,
            color: await this.getTabGroupColor(defaultName),
            pinnedTabIds: [],
            temporaryTabs: [],
            lastTab: null
        };
    },

    getSidebarState: async function () {
        const result = await chrome.storage.local.get([SIDEBAR_STATE_KEY]);
        const migrated = result[SIDEBAR_STATE_KEY] || await this.getDefaultSidebarState();

        const normalized = {
            ...(await this.getDefaultSidebarState()),
            ...migrated,
            id: MAIN_SIDEBAR_ID,
            pinnedTabIds: Array.isArray(migrated?.pinnedTabIds) ? migrated.pinnedTabIds : [],
            temporaryTabs: Array.isArray(migrated?.temporaryTabs) ? migrated.temporaryTabs : []
        };

        await this.saveSidebarState(normalized);
        return normalized;
    },

    saveSidebarState: async function (sidebarState) {
        const normalized = {
            ...(await this.getDefaultSidebarState()),
            ...sidebarState,
            id: MAIN_SIDEBAR_ID,
            pinnedTabIds: Array.isArray(sidebarState?.pinnedTabIds) ? sidebarState.pinnedTabIds : [],
            temporaryTabs: Array.isArray(sidebarState?.temporaryTabs) ? sidebarState.temporaryTabs : []
        };

        await chrome.storage.local.set({ [SIDEBAR_STATE_KEY]: normalized });
        return normalized;
    },

    // Get all overrides (keyed by tabId)
    getTabNameOverrides: async function () {
        const result = await chrome.storage.local.get('tabNameOverridesById'); // Changed key
        return result.tabNameOverridesById || {}; // Changed key
    },

    // Save all overrides (keyed by tabId)
    saveTabNameOverrides: async function (overrides) {
        await chrome.storage.local.set({ tabNameOverridesById: overrides }); // Changed key
    },

    // Set or update a single override using tabId
    setTabNameOverride: async function (tabId, url, name) { // Added tabId, kept url for domain
        if (!tabId || !url || !name) return; // Basic validation

        const overrides = await this.getTabNameOverrides();
        try {
            // Still store originalDomain in case we need it later, derived from the URL at time of setting
            const originalDomain = new URL(url).hostname;
            overrides[tabId] = { name: name, originalDomain: originalDomain }; // Use tabId as key
            await this.saveTabNameOverrides(overrides);
            Logger.log(`Override set for tab ${tabId}: ${name}`);
        } catch (e) {
            Logger.error("Error setting override - invalid URL?", url, e);
        }
    },

    // Remove an override using tabId
    removeTabNameOverride: async function (tabId) { // Changed parameter to tabId
        if (!tabId) return;

        const overrides = await this.getTabNameOverrides();
        if (overrides[tabId]) { // Check using tabId
            delete overrides[tabId]; // Delete using tabId
            await this.saveTabNameOverrides(overrides);
            Logger.log(`Override removed for tab ${tabId}`);
        }
    },

    // --- Pinned Bookmark Tab State ---
    // Tracks the original "pinned/bookmark URL" for a pinned tab, even if the user navigates away.
    // Keyed by ephemeral tabId (per session) which is sufficient for Arc-like "Back to Pinned URL".
    getPinnedTabStates: async function () {
        const result = await chrome.storage.local.get('pinnedTabStatesById');
        return result.pinnedTabStatesById || {};
    },

    savePinnedTabStates: async function (states) {
        await chrome.storage.local.set({ pinnedTabStatesById: states || {} });
    },

    getPinnedTabState: async function (tabId) {
        if (!tabId) return null;
        const states = await this.getPinnedTabStates();
        return states[tabId] || null;
    },

    setPinnedTabState: async function (tabId, state) {
        if (!tabId || !state) return;
        const states = await this.getPinnedTabStates();
        states[tabId] = {
            pinnedUrl: state.pinnedUrl || null,
            bookmarkId: state.bookmarkId || null
        };
        await this.savePinnedTabStates(states);
    },

    removePinnedTabState: async function (tabId) {
        if (!tabId) return;
        const states = await this.getPinnedTabStates();
        if (states[tabId]) {
            delete states[tabId];
            await this.savePinnedTabStates(states);
        }
    },

    getTabGroupColor: async function (groupName) {
        let tabGroups = await chrome.tabGroups.query({});

        const chromeTabGroupColors = [
            'grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan'
        ];
        const existingGroup = tabGroups.find(group => group.title === groupName);
        if (existingGroup) {
            return existingGroup.color;
        } else {
            const randomIndex = Math.floor(Math.random() * chromeTabGroupColors.length);
            return chromeTabGroupColors[randomIndex];
        }
    },

    // Function to get if archiving is enabled
    isArchivingEnabled: async function () {
        const settings = await this.getSettings();
        return settings.autoArchiveEnabled;
    },

    // Get all archived tabs
    getArchivedTabs: async function () {
        const result = await chrome.storage.local.get(ARCHIVED_TABS_KEY);
        return result[ARCHIVED_TABS_KEY] || [];
    },

    // Save all archived tabs
    saveArchivedTabs: async function (tabs) {
        await chrome.storage.local.set({ [ARCHIVED_TABS_KEY]: tabs });
    },

    // Add a tab to the archive
    addArchivedTab: async function (tabData) { // tabData = { url, name, sidebarId, archivedAt }
        if (!tabData || !tabData.url || !tabData.name) return;

        const archivedTabs = await this.getArchivedTabs();

        // Check if URL already exists in archive regardless of its original sidebar state
        const existingTab = archivedTabs.find(t => t.url === tabData.url);
        if (existingTab) {
            Logger.log(`Tab with URL already archived: ${tabData.name} (${tabData.url})`);
            return; // Don't add duplicates based on URL
        }

        // Add new tab with timestamp
        const newArchiveEntry = { ...tabData, collectionId: tabData.collectionId || MAIN_SIDEBAR_ID, archivedAt: Date.now() };
        archivedTabs.push(newArchiveEntry);

        // Sort by timestamp (newest first for potential slicing, though FIFO means oldest removed)
        archivedTabs.sort((a, b) => b.archivedAt - a.archivedAt);

        // Enforce limit (remove oldest if over limit - FIFO)
        if (archivedTabs.length > MAX_ARCHIVED_TABS) {
            archivedTabs.splice(MAX_ARCHIVED_TABS); // Remove items from the end (oldest)
        }

        await this.saveArchivedTabs(archivedTabs);
        Logger.log(`Archived tab: ${tabData.name} from sidebar ${newArchiveEntry.collectionId}`);
    },

    // Function to archive a tab (likely called from context menu)
    archiveTab: async function (tabId) {
        try {
            const tab = await chrome.tabs.get(tabId);
            if (!tab) return;

            const tabData = {
                url: tab.url,
                name: tab.title,
                collectionId: MAIN_SIDEBAR_ID
            };

            await this.addArchivedTab(tabData);
            await chrome.tabs.remove(tabId); // Close the original tab
            // Optionally: Refresh sidebar view if needed, though handleTabRemove should cover it

        } catch (error) {
            Logger.error(`Error archiving tab ${tabId}:`, error);
        }
    },

    // Remove a tab from the archive (e.g., after restoration)
    removeArchivedTab: async function (url, collectionId = MAIN_SIDEBAR_ID) {
        if (!url) return;

        let archivedTabs = await this.getArchivedTabs();
        archivedTabs = archivedTabs.filter(tab => !(tab.url === url && (tab.collectionId || MAIN_SIDEBAR_ID) === collectionId));
        await this.saveArchivedTabs(archivedTabs);
        Logger.log(`Removed archived tab: ${url} from sidebar ${collectionId}`);
    },

    restoreArchivedTab: async function (archivedTabData) {
        try {
            const newTab = await chrome.tabs.create({
                url: archivedTabData.url,
                active: true,
            });

            // Remove from archive storage
            await this.removeArchivedTab(archivedTabData.url, archivedTabData.collectionId || MAIN_COLLECTION_ID);

            // Return the created tab so caller can pin it if needed
            return newTab;

        } catch (error) {
            Logger.error(`Error restoring archived tab ${archivedTabData.url}:`, error);
            throw error;
        }
    },

    setArchivingEnabled: async function (enabled) {
        const settings = await this.getSettings();
        settings.autoArchiveEnabled = enabled;
        await chrome.storage.sync.set({ autoArchiveEnabled: enabled });
    },

    setArchiveTime: async function (minutes) {
        const settings = await this.getSettings();
        settings.autoArchiveIdleMinutes = minutes;
        await chrome.storage.sync.set({ autoArchiveIdleMinutes: minutes });
    },

    getInvertTabOrder: async function () {
        const settings = await this.getSettings();
        return settings.invertTabOrder;
    },

    setInvertTabOrder: async function (enabled) {
        await chrome.storage.sync.set({ invertTabOrder: enabled });
    },

    // Navigate to adjacent tab within the single Arcify sidebar
    _navigateTabInState: async function (tabId, sidebarState, direction) {
        const temporaryTabs = sidebarState?.temporaryTabs ?? [];
        const pinnedTabs = sidebarState?.pinnedTabIds ?? [];
        const allTabs = [...pinnedTabs, ...temporaryTabs];

        if (allTabs.length === 0) return;

        const currentIndex = allTabs.indexOf(tabId);
        if (currentIndex === -1) return;

        const nextIndex = direction === 'next'
            ? (currentIndex + 1) % allTabs.length
            : (currentIndex - 1 + allTabs.length) % allTabs.length;

        chrome.tabs.update(allTabs[nextIndex], { active: true });
    },

    moveToNextTabInSidebar: async function (tabId, sidebarState) {
        return this._navigateTabInState(tabId, sidebarState, 'next');
    },

    moveToPrevTabInSidebar: async function (tabId, sidebarState) {
        return this._navigateTabInState(tabId, sidebarState, 'prev');
    },
    findActiveSidebarTab: async function () {
        Logger.log("[TabNavigation] finding active tab in sidebar state");
        const sidebarState = await this.getSidebarState();
        const foundTabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (foundTabs.length === 0) {
            Logger.log("[TabNavigation] No active tab found!:");
            return undefined;
        }
        const foundTab = foundTabs[0];
        if (sidebarState.temporaryTabs.includes(foundTab.id)) {
            Logger.log(`[TabNavigation] Tab ${foundTab.id} is a temporary tab in the main sidebar.`);
            return { state: sidebarState, tab: foundTab };
        }

        if (sidebarState.pinnedTabIds.includes(foundTab.id)) {
            Logger.log(`[TabNavigation] Tab ${foundTab.id} is a pinned tab in the main sidebar.`);
            return { state: sidebarState, tab: foundTab };
        }

        return undefined
    },

    // Helper function to adjust menu position to keep it within viewport
    adjustMenuPosition: function (menu, x, y) {
        // Ensure menu is in DOM to get dimensions
        if (!menu.isConnected) {
            Logger.warn('Menu must be in DOM to adjust position');
            return;
        }

        const rect = menu.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        let left = x;
        let top = y;

        // Check right edge
        if (left + rect.width > viewportWidth) {
            left = viewportWidth - rect.width - 5; // 5px padding
        }

        // Check bottom edge
        if (top + rect.height > viewportHeight) {
            top = viewportHeight - rect.height - 5; // 5px padding
        }

        // Check left edge (unlikely but possible)
        if (left < 0) {
            left = 5;
        }

        // Check top edge
        if (top < 0) {
            top = 5;
        }

        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
    }
}

export { Utils };
