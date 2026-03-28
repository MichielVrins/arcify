/**
 * Bookmark Utils - Consolidated bookmark operations for Arcify Chrome Extension
 * 
 * Purpose: Centralized utilities for all bookmark-related operations to eliminate code duplication
 * Key Functions: Arcify folder management, recursive traversal, URL matching, bookmark operations
 * Architecture: Static utility class with consistent error handling and Chrome API abstraction
 * 
 * Critical Notes:
 * - Uses robust 3-method fallback approach for finding Arcify folder
 * - Provides unified recursive traversal with flexible options
 * - Centralizes URL matching logic with normalization
 * - Ensures consistent error handling across all bookmark operations
 * - Does not handle folder creation - defers to LocalStorage for that functionality
 */

import { Logger } from './logger.js';

export const BookmarkUtils = {

    /**
     * Robust method to find the Arcify folder in Chrome bookmarks
     * Uses 3-method fallback approach for maximum reliability across browsers/locales
     * @returns {Promise<Object|null>} The Arcify folder object or null if not found
     */
    async findArcifyFolder() {
        try {
            // Method 1: Try the standard search first (most common case)
            const searchResults = await chrome.bookmarks.search({ title: 'Arcify' });
            const arcifyViaSearch = searchResults?.find(result => !result.url);
            if (arcifyViaSearch) {
                Logger.log('[BookmarkUtils] Found Arcify folder via search:', arcifyViaSearch.id);
                return arcifyViaSearch;
            }

            // Method 2: Traverse the bookmark tree manually
            const rootChildren = await chrome.bookmarks.getChildren('0');
            for (const rootFolder of rootChildren) {
                try {
                    const children = await chrome.bookmarks.getChildren(rootFolder.id);
                    const arcifyFolder = children.find(child => child.title === 'Arcify' && !child.url);
                    if (arcifyFolder) {
                        Logger.log('[BookmarkUtils] Found Arcify folder in', rootFolder.title);
                        return arcifyFolder;
                    }
                } catch {
                    continue;
                }
            }

            // Method 3: Check "Other Bookmarks" specifically (handles locale variations)
            const otherBookmarksFolder = rootChildren.find(folder =>
                folder.id === '2' ||
                folder.title.toLowerCase().includes('other') ||
                folder.title.toLowerCase().includes('bookmark')
            );

            if (otherBookmarksFolder) {
                try {
                    const children = await chrome.bookmarks.getChildren(otherBookmarksFolder.id);
                    const arcifyFolder = children.find(child => child.title === 'Arcify' && !child.url);
                    if (arcifyFolder) {
                        Logger.log('[BookmarkUtils] Found Arcify folder in Other Bookmarks');
                        return arcifyFolder;
                    }
                } catch {
                    // Ignore error
                }
            }

            Logger.log('[BookmarkUtils] Arcify folder not found');
            return null;

        } catch (error) {
            Logger.error('[BookmarkUtils] Error in findArcifyFolder:', error);
            return null;
        }
    },


    /**
     * Recursively get all bookmarks from a folder and its subfolders
     * @param {string} folderId - ID of the folder to search
     * @param {Object} options - Options for filtering and processing
     * @param {boolean} options.includeTabIds - Whether to include tab IDs for matching tabs
     * @param {number} options.groupId - Group ID to match tabs against (if includeTabIds is true)
     * @returns {Promise<Array>} Array of bookmark objects
     */
    async getBookmarksFromFolderRecursive(folderId, options = {}) {
        const { includeTabIds = false, groupId = null } = options;
        const bookmarks = [];
        const items = await chrome.bookmarks.getChildren(folderId);

        // Get tabs once if needed for matching
        let tabs = [];
        if (includeTabIds && groupId !== null) {
            tabs = await chrome.tabs.query({ groupId: groupId });
        }

        for (const item of items) {
            if (item.url) {
                // This is a bookmark
                const bookmarkData = {
                    id: item.id,
                    title: item.title,
                    url: item.url
                };

                // Add tab ID if requested and found
                if (includeTabIds && tabs.length > 0) {
                    const matchingTab = tabs.find(t => t.url === item.url);
                    if (matchingTab) {
                        bookmarkData.tabId = matchingTab.id;
                    }
                }

                bookmarks.push(bookmarkData);
            } else {
                // This is a folder, recursively get bookmarks
                const subBookmarks = await this.getBookmarksFromFolderRecursive(item.id, options);
                bookmarks.push(...subBookmarks);
            }
        }

        return bookmarks;
    },

    /**
     * Recursively find a bookmark by URL and/or title within a folder and all its subfolders
     * @param {string} folderId - The folder ID to search in
     * @param {Object} searchCriteria - Search criteria object with url and/or title properties
     * @param {string} [searchCriteria.url] - URL to search for
     * @param {string} [searchCriteria.title] - Title to search for
     * @returns {Promise<Object|null>} Object with bookmark, parentFolderId, and folderPath, or null if not found
     */
    async findBookmarkInFolderRecursive(folderId, searchCriteria) {
        const { url, title } = searchCriteria;
        const searchDesc = url ? `URL: ${url}` : title ? `title: ${title}` : 'unknown criteria';
        Logger.log(`[BookmarkUtils] Searching for bookmark with ${searchDesc} in folder: ${folderId}`);

        if (!folderId || (!url && !title)) {
            Logger.warn('[BookmarkUtils] Missing folderId or search criteria (url/title) for recursive search');
            return null;
        }

        try {
            const items = await chrome.bookmarks.getChildren(folderId);
            Logger.log(`[BookmarkUtils] Found ${items.length} items in folder ${folderId}`);

            for (const item of items) {
                if (item.url) {
                    // This is a bookmark - check if it matches search criteria
                    let matches = false;

                    if (url && item.url === url) {
                        matches = true;
                    }

                    if (title && item.title === title) {
                        matches = true;
                    }

                    if (matches) {
                        Logger.log(`[BookmarkUtils] Found matching bookmark: ${item.title} in folder ${folderId}`);
                        return {
                            bookmark: item,
                            parentFolderId: folderId,
                            folderPath: folderId // Could be enhanced to return full path
                        };
                    }
                } else {
                    // This is a folder - recurse into it
                    Logger.log(`[BookmarkUtils] Recursing into subfolder: ${item.title} (${item.id})`);
                    const result = await this.findBookmarkInFolderRecursive(item.id, searchCriteria);
                    if (result) {
                        Logger.log(`[BookmarkUtils] Found bookmark in subfolder: ${item.title}`);
                        return result;
                    }
                }
            }

            Logger.log(`[BookmarkUtils] Bookmark not found in folder ${folderId}`);
            return null;

        } catch (error) {
            Logger.error(`[BookmarkUtils] Error searching folder ${folderId}:`, error);
            return null;
        }
    },

    /**
     * Find an item by URL in an array of objects with url property
     * @param {Array} items - Array of objects with url property (bookmarks, tabs, etc.)
     * @param {string} url - URL to search for
     * @returns {Object|null} The matching item or null
     */
    _findByUrl(items, url) {
        if (!items || !url) return null;
        return items.find(item => item.url === url) || null;
    },

    /**
     * Find a bookmark by URL in an array of bookmarks
     */
    findBookmarkByUrl(bookmarks, url) {
        return this._findByUrl(bookmarks, url);
    },

    /**
     * Find a tab by URL in an array of tabs
     */
    findTabByUrl(tabs, url) {
        return this._findByUrl(tabs, url);
    },

    /**
     * Open bookmark as active tab, handling all UI updates and data management
     * @param {Object} bookmarkData - Bookmark data object
     * @param {string} bookmarkData.url - Bookmark URL
     * @param {string} bookmarkData.title - Bookmark title
     * @param {string} bookmarkData.sidebarName - Sidebar name the bookmark belongs to
     * @param {HTMLElement} replaceElement - DOM element to replace with active tab element (optional)
     * @param {Object} context - Context object with required functions and data
     * @returns {Object} The created Chrome tab object
     */
    async openBookmarkAsTab(bookmarkData, replaceElement = null, context, isPinned) {
        const {
            sidebarState,
            currentWindow,
            saveSidebarState,
            createTabElement,
            activateTabInDOM,
            Utils
        } = context;

        Logger.log('[BookmarkUtils] Opening bookmark as tab:', bookmarkData.url);

        // Create new tab with bookmark URL in the target group
        const newTab = await chrome.tabs.create({
            url: bookmarkData.url,
            active: true,
            windowId: currentWindow.id
        });

        // If bookmark has a custom name, set tab name override
        if (bookmarkData.title && newTab.title !== bookmarkData.title) {
            await Utils.setTabNameOverride(newTab.id, bookmarkData.url, bookmarkData.title);
        }

        if (isPinned) {
            if (sidebarState && !sidebarState.pinnedTabIds.includes(newTab.id)) {
                sidebarState.pinnedTabIds.push(newTab.id);
                saveSidebarState();
            }

            // Track pinned URL/bookmarkId for Arc-like "Back to Pinned URL" behavior.
            if (Utils && typeof Utils.setPinnedTabState === 'function') {
                await Utils.setPinnedTabState(newTab.id, {
                    pinnedUrl: bookmarkData.url,
                    bookmarkId: bookmarkData.bookmarkId || null
                });
            }
        }

        // Replace bookmark-only element with active tab element if provided
        if (replaceElement && createTabElement) {
            const activeTabData = {
                id: newTab.id,
                title: bookmarkData.title,
                url: bookmarkData.url,
                favIconUrl: newTab.favIconUrl,
                sidebarName: bookmarkData.sidebarName,
                pinnedUrl: bookmarkData.url,
                bookmarkId: bookmarkData.bookmarkId || null
            };
            const activeTabElement = await createTabElement(activeTabData, true, false);
            activeTabElement.classList.add('active');
            replaceElement.replaceWith(activeTabElement);
        }

        // Ensure the tab is actually active
        await chrome.tabs.update(newTab.id, { active: true });

        // Visually activate the tab
        if (activateTabInDOM) {
            activateTabInDOM(newTab.id);
        }

        Logger.log('[BookmarkUtils] Successfully opened bookmark as tab:', newTab.id);
        return newTab;
    },

    /**
     * Search and remove bookmark by URL from a folder structure recursively
     * @param {string} folderId - ID of the folder to search in
     * @param {string} tabUrl - URL of the bookmark to remove
     * @param {Object} options - Options for the removal operation
     * @param {boolean} options.removeTabElement - Whether to also remove the tab element from DOM
     * @param {Element} options.tabElement - The tab element to remove if removeTabElement is true
     * @param {boolean} options.logRemoval - Whether to log the removal
     * @returns {Promise<boolean>} True if bookmark was found and removed
     */
    async removeBookmarkByUrl(folderId, tabUrl, options = {}) {
        const {
            removeTabElement = false,
            tabElement = null,
            logRemoval = false
        } = options;

        const items = await chrome.bookmarks.getChildren(folderId);
        for (const item of items) {
            if (item.url === tabUrl) {
                if (logRemoval) {
                    Logger.log('[BookmarkUtils] Removing bookmark:', item);
                }
                await chrome.bookmarks.remove(item.id);

                if (removeTabElement && tabElement) {
                    tabElement.remove();
                }

                return true; // Bookmark found and removed
            } else if (!item.url) {
                // This is a folder, search recursively
                const found = await this.removeBookmarkByUrl(item.id, tabUrl, options);
                if (found) return true;
            }
        }
        return false; // Bookmark not found
    },

    /**
     * Check if a bookmark is under the Arcify folder hierarchy
     * @param {Object} bookmark - Bookmark object
     * @param {string} arcifyFolderId - Arcify folder ID
     * @returns {boolean} True if bookmark is under Arcify folder
     */
    isUnderArcifyFolder(bookmark, arcifyFolderId) {
        // Simple heuristic: check if the bookmark's parent path includes the Arcify folder
        // This is a simplified check - for a more robust solution, we'd need to traverse up the parent chain
        return bookmark.parentId && (bookmark.parentId === arcifyFolderId ||
            bookmark.parentId.startsWith(arcifyFolderId));
    },

    /**
     * Get bookmarks data with Arcify folder exclusion
     * @param {string} query - Search query
     * @returns {Promise<Array>} Filtered bookmarks array
     */
    async getBookmarksData(query) {
        try {
            const bookmarks = await chrome.bookmarks.search(query);

            // Get Arcify folder to exclude its bookmarks from regular bookmark search
            let arcifyFolderId = null;
            try {
                const arcifyFolder = await this.findArcifyFolder();
                if (arcifyFolder) {
                    arcifyFolderId = arcifyFolder.id;
                }
            } catch (error) {
                // Ignore error if Arcify folder doesn't exist
            }

            // Filter out Arcify bookmarks and keep only bookmarks with URLs
            const filteredBookmarks = bookmarks.filter(bookmark => {
                if (!bookmark.url) return false;

                // Exclude bookmarks that are under Arcify folder
                if (arcifyFolderId && this.isUnderArcifyFolder(bookmark, arcifyFolderId)) {
                    return false;
                }

                return true;
            });

            return filteredBookmarks;
        } catch (error) {
            Logger.error('[BookmarkUtils] Error getting bookmarks:', error);
            return [];
        }
    }
};
