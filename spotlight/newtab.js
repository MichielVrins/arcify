/**
 * New Tab Spotlight - Standalone spotlight page for new tab override
 * 
 * Purpose: Provides spotlight functionality on new tab page
 * Use Case: Fallback when spotlight cannot be injected (chrome:// URLs, restricted pages)
 * Architecture: Reuses shared spotlight modules in standalone page context
 */

import { SpotlightUtils } from './shared/ui-utilities.js';
import {
    getSpotlightMarkup,
    mountSpotlightController
} from './shared/spotlight-controller.js';
import { Logger } from '../logger.js';

// Initialize spotlight on page load
// Initialize spotlight on page load
document.addEventListener('DOMContentLoaded', async () => {
    const container = document.getElementById('spotlight-container');

    // Check if spotlight is enabled (controls both spotlight and custom new tab)
    const settings = await chrome.storage.sync.get({ enableSpotlight: true });

    if (!settings.enableSpotlight) {
        // Request background script to navigate to default new tab
        try {
            await chrome.runtime.sendMessage({
                action: 'navigateToDefaultNewTab'
            });
        } catch (error) {
            Logger.error('[NewTab] Error navigating to default new tab:', error);
        }
        return;
    }

    // If enabled, show container and initialize
    if (container) {
        container.style.visibility = 'visible';
    }
    await initializeSpotlight();
});

async function initializeSpotlight() {
    const container = document.getElementById('spotlight-container');

    const accentColorDefinitions = SpotlightUtils.getAccentColorCSS();
    const spotlightCSS = `
        ${accentColorDefinitions}
        
        /* Smooth transitions for color changes */
        :root {
            transition: --spotlight-accent-color 0.3s ease,
                       --spotlight-accent-color-15 0.3s ease,
                       --spotlight-accent-color-20 0.3s ease,
                       --spotlight-accent-color-80 0.3s ease;
        }
        
        .arcify-spotlight-wrapper {
            background: #2D2D2D;
            border-radius: 12px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            padding: 0;
            color: #ffffff;
            position: relative;
            overflow: hidden;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
            animation: spotlight-appear 0.3s ease-out;
        }

        @keyframes spotlight-appear {
            from {
                opacity: 0;
                transform: scale(0.95);
            }
            to {
                opacity: 1;
                transform: scale(1);
            }
        }

        .arcify-spotlight-input-wrapper {
            display: flex;
            align-items: center;
            padding: 12px 24px 12px 20px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }

        .arcify-spotlight-search-icon {
            width: 20px;
            height: 20px;
            margin-right: 12px;
            opacity: 0.6;
            flex-shrink: 0;
        }

        .arcify-spotlight-input {
            flex: 1;
            background: transparent;
            border: none;
            color: #ffffff;
            font-size: 18px;
            line-height: 24px;
            padding: 8px 0;
            outline: none;
            font-weight: 400;
        }

        .arcify-spotlight-input::placeholder {
            color: rgba(255, 255, 255, 0.5);
        }

        .arcify-spotlight-results {
            max-height: 270px;
            overflow-y: auto;
            padding: 8px 0;
            scroll-behavior: smooth;
            scrollbar-width: none;
            -ms-overflow-style: none;
        }

        .arcify-spotlight-results::-webkit-scrollbar {
            display: none;
        }

        .arcify-spotlight-result-item {
            display: flex;
            align-items: center;
            padding: 12px 24px 12px 20px;
            min-height: 44px;
            cursor: pointer;
            transition: background-color 0.15s ease;
            border: none;
            background: none;
            width: 100%;
            text-align: left;
            color: inherit;
            font-family: inherit;
        }

        .arcify-spotlight-result-item:hover,
        .arcify-spotlight-result-item:focus {
            background: var(--spotlight-accent-color-15);
            outline: none;
        }

        .arcify-spotlight-result-item.selected {
            background: var(--spotlight-accent-color-20);
        }

        .arcify-spotlight-result-favicon {
            width: 20px;
            height: 20px;
            margin-right: 12px;
            border-radius: 4px;
            flex-shrink: 0;
        }

        .arcify-spotlight-result-content {
            flex: 1;
            min-width: 0;
            min-height: 32px;
            display: flex;
            flex-direction: column;
            justify-content: center;
        }

        .arcify-spotlight-result-title {
            font-size: 14px;
            font-weight: 500;
            color: #ffffff;
            margin: 0 0 2px 0;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .arcify-spotlight-result-url {
            font-size: 12px;
            color: rgba(255, 255, 255, 0.6);
            margin: 0;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .arcify-spotlight-result-url:empty {
            display: none;
        }

        .arcify-spotlight-result-action {
            font-size: 12px;
            color: var(--spotlight-accent-color-80);
            margin-left: 12px;
            flex-shrink: 0;
        }

        .arcify-spotlight-loading {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 24px;
            color: rgba(255, 255, 255, 0.6);
        }

        .arcify-spotlight-empty {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 24px;
            color: rgba(255, 255, 255, 0.6);
            font-size: 14px;
        }

        @media (max-width: 640px) {
            .arcify-spotlight-input {
                font-size: 16px;
            }
        }
    `;

    // Create and inject styles
    const styleSheet = document.createElement('style');
    styleSheet.id = 'arcify-spotlight-styles';
    styleSheet.textContent = spotlightCSS;
    document.head.appendChild(styleSheet);

    container.innerHTML = `
        <div class="arcify-spotlight-wrapper">
            ${getSpotlightMarkup('Search or enter URL...')}
        </div>
    `;
    const controller = mountSpotlightController({
        root: container,
        mode: 'current-tab'
    });
    chrome.runtime.onMessage.addListener((message) => {
        if (message.action === 'focusSpotlightNewTab') {
            controller.focus();
        }
    });
}
