// message-client.js - Shared message passing abstraction for spotlight components
// Consolidates chrome.runtime.sendMessage patterns from overlay.js and popup.js

import { Logger } from '../../logger.js';

export class SpotlightMessageClient {
    static sendWithoutResponse(message, errorContext) {
        try {
            const pending = chrome.runtime.sendMessage(message);
            pending?.catch((error) => {
                Logger.error(errorContext, error);
            });
        } catch (error) {
            Logger.error(errorContext, error);
        }
    }

    // Get suggestions from background script
    static async getSuggestions(query, mode) {
        try {
            const message = {
                action: 'getSpotlightSuggestions',
                query: query.trim(),
                mode: mode
            };

            const response = await chrome.runtime.sendMessage(message);

            if (response && response.success) {
                return response.results;
            } else {
                Logger.error('[SpotlightMessageClient] Get suggestions failed:', response?.error);
                return [];
            }
        } catch (error) {
            Logger.error('[SpotlightMessageClient] Get suggestions error:', error);
            return [];
        }
    }

    // Handle result action via message passing
    static async handleResult(result, mode) {
        try {
            const message = {
                action: 'spotlightHandleResult',
                result: result,
                mode: mode,
                tabId: window.arcifyCurrentTabId || null  // Include tab ID for optimization
            };

            const response = await chrome.runtime.sendMessage(message);

            if (!response || response.success === false) {
                Logger.error('[SpotlightMessageClient] Result action failed:', response?.error || 'No response');
                return false;
            }
            return true;
        } catch (error) {
            Logger.error('[SpotlightMessageClient] Error handling result action:', error);
            return false;
        }
    }


    // Notify background that spotlight opened
    static notifyOpened() {
        this.sendWithoutResponse(
            { action: 'spotlightOpened' },
            '[SpotlightMessageClient] Error notifying spotlight opened:'
        );
    }

    // Notify background that spotlight closed
    static notifyClosed() {
        this.sendWithoutResponse(
            { action: 'spotlightClosed' },
            '[SpotlightMessageClient] Error notifying spotlight closed:'
        );
    }

    // Switch to tab (new-tab mode)
    static async switchToTab(tabId, windowId) {
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'switchToTab',
                tabId: tabId,
                windowId: windowId
            });
            return response?.success === true;
        } catch (error) {
            Logger.error('[SpotlightMessageClient] Error switching to tab:', error);
            return false;
        }
    }

    // Navigate current tab
    static async navigateCurrentTab(url) {
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'navigateCurrentTab',
                url: url
            });
            return response?.success === true;
        } catch (error) {
            Logger.error('[SpotlightMessageClient] Error navigating current tab:', error);
            return false;
        }
    }


    // Open new tab
    static async openNewTab(url) {
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'openNewTab',
                url: url
            });
            return response?.success === true;
        } catch (error) {
            Logger.error('[SpotlightMessageClient] Error opening new tab:', error);
            return false;
        }
    }

    // Perform search
    static async performSearch(query, mode) {
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'performSearch',
                query: query,
                mode: mode
            });
            return response?.success === true;
        } catch (error) {
            Logger.error('[SpotlightMessageClient] Error performing search:', error);
            return false;
        }
    }

    // Setup message listener for global close commands
    static setupGlobalCloseListener(onCloseCallback) {
        const messageListener = (message) => {
            if (message.action === 'closeSpotlight') {
                onCloseCallback();
            }
        };

        chrome.runtime.onMessage.addListener(messageListener);

        // Return cleanup function
        return () => {
            chrome.runtime.onMessage.removeListener(messageListener);
        };
    }
}
