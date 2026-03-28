/**
 * DOMManager - Sidebar DOM manipulation and UI component management
 * 
 * Purpose: Handles dynamic DOM creation, updates, and event handling for sidebar interface
 * Key Functions: Tab DOM rendering, context menus, input dialogs, drag-and-drop visual feedback
 * Architecture: Utility functions for DOM manipulation and UI state management
 * 
 * Critical Notes:
 * - Separates DOM manipulation logic from business logic in sidebar.js
 * - Handles complex UI interactions like drag-and-drop visual feedback
 * - Manages context menus and modal dialogs for user interactions
 * - Provides reusable UI components for consistent user experience
 */

import { Utils } from './utils.js';
import { RESTORE_ICON } from './icons.js';
import { Logger } from './logger.js';

// DOM Elements
const newTabBtn = document.getElementById('newTabBtn');

export function setupDOMElements() {
    newTabBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ command: "toggleSpotlightNewTab" });
    });

    document.querySelectorAll('.sidebar-color-select').forEach(select => {
        const colorPicker = select.nextElementSibling;
        const currentColor = select.value;
        const swatch = colorPicker.querySelector(`[data-color="${currentColor}"]`);
        if (swatch) {
            swatch.classList.add('selected');
        }
    });

}

export function activateTabInDOM(tabId) {
    // Remove active class from all tabs and pinned favicons
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.pinned-favicon').forEach(f => f.classList.remove('active'));

    // If there's a tab element with this ID, mark it active
    const targetTab = document.querySelector(`[data-tab-id="${tabId}"]`);
    if (targetTab) {
        targetTab.classList.add('active');
    }
}

export function applySidebarColor(color) {
    const sidebarContainer = document.getElementById('sidebar-container');
    if (!sidebarContainer || !color) return;
    const colorValue = `var(--chrome-${color}-color, rgba(255, 255, 255, 0.1))`;
    const colorDarkValue = `var(--chrome-${color}-color-dark, rgba(255, 255, 255, 0.1))`;
    sidebarContainer.style.setProperty('--sidebar-bg-color', colorValue);
    sidebarContainer.style.setProperty('--sidebar-bg-color-dark', colorDarkValue);
    sidebarContainer.style.setProperty('--collection-bg-color', colorValue);
    sidebarContainer.style.setProperty('--collection-bg-color-dark', colorDarkValue);
}

export function showTabContextMenu(x, y, tab, isPinned, isBookmarkOnly, tabElement, closeTab, onReplaceBookmarkUrlWithCurrent = null) {
    // Remove any existing context menus
    const existingMenu = document.getElementById('tab-context-menu');
    if (existingMenu) {
        existingMenu.remove();
    }

    const contextMenu = document.createElement('div');
    contextMenu.id = 'tab-context-menu';
    contextMenu.className = 'context-menu'; // Reuse general context menu styling
    contextMenu.style.position = 'fixed';
    contextMenu.style.left = `${x}px`;
    contextMenu.style.top = `${y}px`;

    // --- Menu Items ---

    // Only show these options for actual tabs managed by Arcify
    if (!isBookmarkOnly) {
        const addToFavoritesOption = document.createElement('div');
        addToFavoritesOption.className = 'context-menu-item';
        addToFavoritesOption.textContent = 'Add to Favorites';
        addToFavoritesOption.addEventListener('click', async () => {
            await chrome.tabs.update(tab.id, { pinned: true });
            contextMenu.remove();
        });
        contextMenu.appendChild(addToFavoritesOption);

        const pinOption = document.createElement('div');
        pinOption.className = 'context-menu-item';
        pinOption.textContent = isPinned ? 'Unpin Tab' : 'Pin Tab';
        pinOption.addEventListener('click', () => {
            chrome.runtime.sendMessage({ command: isPinned ? 'unpinTab' : 'pinTab', tabId: tab.id });
            contextMenu.remove();
        });
        contextMenu.appendChild(pinOption);

        // Arc-like: allow updating the underlying pinned bookmark URL to the current tab URL.
        if (isPinned && typeof onReplaceBookmarkUrlWithCurrent === 'function') {
            const replaceBookmarkUrlOption = document.createElement('div');
            replaceBookmarkUrlOption.className = 'context-menu-item';
            replaceBookmarkUrlOption.textContent = 'Replace Pinned URL with Current URL';
            replaceBookmarkUrlOption.addEventListener('click', async () => {
                try {
                    await onReplaceBookmarkUrlWithCurrent(tab, tabElement);
                } catch (e) {
                    Logger.warn('[ContextMenu] Failed to replace pinned URL with current URL:', e);
                } finally {
                    contextMenu.remove();
                }
            });
            contextMenu.appendChild(replaceBookmarkUrlOption);
        }
    }

    // Archive Tab (Only for active tabs)
    if (!isBookmarkOnly) {
        const archiveOption = document.createElement('div');
        archiveOption.className = 'context-menu-item';
        archiveOption.textContent = 'Archive Tab';
        archiveOption.addEventListener('click', async () => {
            await Utils.archiveTab(tab.id); // Use the utility function
            contextMenu.remove();
        });
        contextMenu.appendChild(archiveOption);
    }

    // Close Tab / Remove Bookmark
    const closeOption = document.createElement('div');
    closeOption.className = 'context-menu-item';
    closeOption.textContent = isBookmarkOnly ? 'Remove Bookmark' : 'Close Tab';
    closeOption.addEventListener('click', () => {
        closeTab(tabElement, tab, isPinned, isBookmarkOnly);
        contextMenu.remove();
    });
    contextMenu.appendChild(closeOption);

    // --- Add to DOM and setup closing ---
    document.body.appendChild(contextMenu);

    // Adjust position to keep within viewport
    Utils.adjustMenuPosition(contextMenu, x, y);

    // Close context menu when clicking outside
    const closeContextMenu = (e) => {
        if (!contextMenu.contains(e.target)) {
            contextMenu.remove();
            document.removeEventListener('click', closeContextMenu, { capture: true }); // Use capture phase
        }
    };
    // Use capture phase to catch clicks before they bubble up
    document.addEventListener('click', closeContextMenu, { capture: true });
}

export async function showArchivedTabsPopup() {
    const sidebarView = document.querySelector('.sidebar-view');
    if (!sidebarView) return;
    const popup = sidebarView.querySelector('.archived-tabs-popup');
    const list = popup.querySelector('.archived-tabs-list');
    const message = popup.querySelector('.no-archived-tabs-message');
    list.innerHTML = '';

    // --- Archiving Controls ---
    let controls = popup.querySelector('.archiving-controls');
    if (!controls) {
        controls = document.createElement('div');
        controls.className = 'archiving-controls';
        popup.insertBefore(controls, list);
    } else {
        controls.innerHTML = '';
    }

    // Fetch current settings
    const settings = await Utils.getSettings();
    const archivingEnabled = settings.autoArchiveEnabled;
    const archiveTime = settings.autoArchiveIdleMinutes;

    // Toggle (styled)
    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'archiving-toggle-label';
    const toggleWrapper = document.createElement('span');
    toggleWrapper.className = 'archiving-toggle';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = archivingEnabled;
    const slider = document.createElement('span');
    slider.className = 'archiving-toggle-slider';
    toggleWrapper.appendChild(toggle);
    toggleWrapper.appendChild(slider);
    toggleLabel.appendChild(toggleWrapper);
    toggleLabel.appendChild(document.createTextNode('Enable Archiving'));
    controls.appendChild(toggleLabel);

    // Archive time input (styled) - display in hours, store in minutes
    const timeContainer = document.createElement('div');
    timeContainer.className = 'archiving-time-container';
    const timeInput = document.createElement('input');
    timeInput.type = 'number';
    timeInput.min = '0.25'; // 15 minutes minimum
    timeInput.step = '0.25'; // 15 minute increments
    timeInput.value = (archiveTime / 60).toFixed(2); // Convert minutes to hours
    timeInput.className = 'archiving-time-input';
    timeInput.disabled = !archivingEnabled;
    const hrLabel = document.createElement('span');
    hrLabel.textContent = 'hr';
    timeContainer.appendChild(timeInput);
    timeContainer.appendChild(hrLabel);
    controls.appendChild(timeContainer);

    // Event listeners
    toggle.addEventListener('change', async (e) => {
        const enabled = toggle.checked;
        timeInput.disabled = !enabled;
        await Utils.setArchivingEnabled(enabled);
    });
    timeInput.addEventListener('change', async (e) => {
        let val = parseFloat(timeInput.value);
        if (isNaN(val) || val < 0.25) val = 0.25; // Minimum 15 minutes
        timeInput.value = val.toFixed(2);
        const minutes = Math.round(val * 60); // Convert hours to minutes
        await Utils.setArchiveTime(minutes);
    });

    // --- End Archiving Controls ---

    if (!archivingEnabled) {
        message.textContent = 'Tab Archiving is disabled. Use the toggle above to enable.';
        list.style.display = 'none';
        return;
    }

    if (!(await Utils.isArchivingEnabled())) {
        message.textContent = 'Tab Archiving is disabled. Go to extension settings to enable.';
        list.style.display = 'none';
        return;
    }

    const allArchived = await Utils.getArchivedTabs();
    if (allArchived.length === 0) {
        message.textContent = 'No archived tabs.';
        list.style.display = 'none';
    } else {
        message.textContent = '';
        list.style.display = 'block';
        allArchived.forEach(archivedTab => {
            const item = document.createElement('div');
            item.className = 'tab archived-item';
            item.title = `${archivedTab.name}\n${archivedTab.url}\nArchived: ${new Date(archivedTab.archivedAt).toLocaleString()}`;

            const favicon = document.createElement('img');
            favicon.src = Utils.getFaviconUrl(archivedTab.url);
            favicon.className = 'tab-favicon';
            favicon.onerror = () => { favicon.src = 'assets/default_icon.png'; };

            const details = document.createElement('div');
            details.className = 'tab-details';
            const titleSpan = document.createElement('span');
            titleSpan.className = 'tab-title-display';
            titleSpan.textContent = archivedTab.name;
            details.appendChild(titleSpan);

            const restoreButton = document.createElement('button');
            restoreButton.innerHTML = RESTORE_ICON;
            restoreButton.className = 'tab-restore';
            restoreButton.style.marginLeft = 'auto';
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                Utils.restoreArchivedTab(archivedTab);
                item.remove();
                if (list.children.length === 0) {
                    message.style.display = 'block';
                    list.style.display = 'none';
                }
            });

            item.appendChild(favicon);
            item.appendChild(details);
            item.appendChild(restoreButton);
            list.appendChild(item);
        });
    }
}

// Toast notification for URL copy success
export function showUrlCopyToast() {
    const toast = document.getElementById('urlCopyToast');
    if (!toast) return;

    // Clear any existing timeout
    if (toast.hideTimeout) {
        clearTimeout(toast.hideTimeout);
    }

    // Show the toast
    toast.classList.add('show');

    // Hide the toast after 2 seconds
    toast.hideTimeout = setTimeout(() => {
        toast.classList.remove('show');
        toast.hideTimeout = null;
    }, 2000);
}

// ============================================================================
// Unified Drag Helper Functions
// ============================================================================

/**
 * Unified function to find the element to insert after during drag-and-drop.
 * Replaces getDragAfterElementSwitcher, getDragAfterElement, and getDragAfterElementFavicon.
 *
 * @param {HTMLElement} container - The container element
 * @param {number} position - The mouse position (clientX for horizontal, clientY for vertical)
 * @param {Object} options - Configuration options
 * @param {string} options.axis - 'x' for horizontal, 'y' for vertical (default: 'y')
 * @param {string} options.selector - CSS selector for draggable elements
 * @param {string} options.placeholderSelector - CSS selector for placeholder element
 * @returns {HTMLElement|null} - The element to insert after, or null
 */
export function getDragAfterElement(container, position, options = {}) {
    const { axis = 'y', selector, placeholderSelector } = options;
    const draggableElements = [...container.querySelectorAll(selector)];

    // If no draggable elements exist, return the placeholder as a reference for empty containers
    if (draggableElements.length === 0) {
        return placeholderSelector ? container.querySelector(placeholderSelector) : null;
    }

    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = axis === 'x'
            ? position - box.left - box.width / 2
            : position - box.top - box.height / 2;

        if (offset < 0 && offset > closest.offset) {
            return { offset, element: child };
        }
        return closest;
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

// ============================================================================
// Container Query Helpers
// ============================================================================

/**
 * Get pinned container for a sidebar view element
 * @param {HTMLElement} collectionElement - The sidebar view element
 * @returns {HTMLElement|null}
 */
export function getPinnedContainer(collectionElement) {
    return collectionElement?.querySelector('[data-tab-type="pinned"]') ?? null;
}

/**
 * Get temporary container for a sidebar view element
 * @param {HTMLElement} collectionElement - The sidebar view element
 * @returns {HTMLElement|null}
 */
export function getTempContainer(collectionElement) {
    return collectionElement?.querySelector('[data-tab-type="temporary"]') ?? null;
}

// ============================================================================
// Active State Management
// ============================================================================

/**
 * Clear active state from all tabs and pinned favicons
 */
export function clearAllActiveStates() {
    document.querySelectorAll('.tab, .pinned-favicon')
        .forEach(el => el.classList.remove('active'));
}

// ============================================================================
// Drop Indicator Functions
// ============================================================================

/**
 * Hide all drop indicators in the document
 */
export function hideAllDropIndicators() {
    document.querySelectorAll('.drop-indicator-horizontal, .drop-indicator-vertical').forEach(element => {
        element.classList.remove('drop-indicator-horizontal', 'drop-indicator-vertical', 'above', 'below', 'left', 'right');
    });
}

/**
 * Show a drop indicator on the target el   
 * @param {HTMLElement} targetElement - The element to show the indicator on
 * @param {string} position - Position: 'above', 'below', 'left', or 'right'
 * @param {boolean} isHorizontal - True for horizontal layout (favicons), false for vertical (tabs)
 */
export function showDropIndicator(targetElement, position, isHorizontal = false) {
    // First, hide all existing indicators
    hideAllDropIndicators();

    if (!targetElement) return;

    if (isHorizontal) {
        // For horizontal favicons (left/right positioning)
        targetElement.classList.add('drop-indicator-vertical');
        targetElement.classList.add(position); // 'left' or 'right'
    } else {
        // For vertical sidebar tabs (above/below positioning)
        targetElement.classList.add('drop-indicator-horizontal');
        targetElement.classList.add(position); // 'above' or 'below'
    }
}

/**
 * Get the drop position relative to an element
 * @param {HTMLElement} element - The target element
 * @param {number} clientX - Mouse X position
 * @param {number} clientY - Mouse Y position
 * @param {boolean} isHorizontal - True for horizontal layout, false for vertical
 * @returns {string|null} - Position: 'above', 'below', 'left', 'right', or null
 */
export function getDropPosition(element, clientX, clientY, isHorizontal = false) {
    if (!element) return null;

    const rect = element.getBoundingClientRect();

    if (isHorizontal) {
        // For horizontal favicons, use X position to determine left/right
        const centerX = rect.left + rect.width / 2;
        return clientX < centerX ? 'left' : 'right';
    } else {
        // For vertical tabs, use Y position to determine above/below
        const centerY = rect.top + rect.height / 2;
        return clientY < centerY ? 'above' : 'below';
    }
}
