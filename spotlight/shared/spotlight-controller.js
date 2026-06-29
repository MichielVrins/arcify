import { Logger } from '../../logger.js';
import { SelectionManager } from './selection-manager.js';
import { SpotlightMessageClient } from './message-client.js';
import { SharedSpotlightLogic } from './shared-component-logic.js';
import { SpotlightUtils } from './ui-utilities.js';

export function getSpotlightMarkup(placeholder) {
    return `
        <div class="arcify-spotlight-input-wrapper">
            <svg class="arcify-spotlight-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="11" cy="11" r="8"></circle>
                <path d="m21 21-4.35-4.35"></path>
            </svg>
            <input
                type="text"
                class="arcify-spotlight-input"
                placeholder="${SpotlightUtils.escapeHtml(placeholder)}"
                spellcheck="false"
                autocomplete="off"
                autocorrect="off"
                autocapitalize="off"
            >
        </div>
        <div class="arcify-spotlight-results">
            <div class="arcify-spotlight-loading">Loading...</div>
        </div>
    `;
}

export function focusSpotlightInput(input) {
    if (!input) return;

    const focus = () => {
        if (!input.isConnected) return;
        input.ownerDocument.defaultView?.focus();
        input.focus({ preventScroll: true });
        input.select();
        input.scrollLeft = 0;
    };

    focus();
    requestAnimationFrame(focus);
    setTimeout(focus, 50);
}

export function mountSpotlightController({
    root,
    mode,
    initialValue = '',
    onBeforeAction = () => {},
    onEscape = () => {},
}) {
    const input = root.querySelector('.arcify-spotlight-input');
    const resultsContainer = root.querySelector('.arcify-spotlight-results');
    if (!input || !resultsContainer) {
        throw new Error('Spotlight shell is missing its input or results container');
    }

    const selectionManager = new SelectionManager(resultsContainer);
    let currentResults = [];
    let instantSuggestion = null;
    let asyncSuggestions = [];
    let requestSequence = 0;

    function displayEmptyState() {
        resultsContainer.innerHTML =
            '<div class="arcify-spotlight-empty">Start typing to search tabs, bookmarks, and history</div>';
        currentResults = [];
        instantSuggestion = null;
        asyncSuggestions = [];
        selectionManager.updateResults([]);
    }

    function updateDisplay() {
        currentResults = SharedSpotlightLogic.combineResults(
            instantSuggestion,
            asyncSuggestions,
        );
        selectionManager.updateResults(currentResults);
        if (currentResults.length === 0) {
            displayEmptyState();
            return;
        }
        SharedSpotlightLogic.updateResultsDisplay(
            resultsContainer,
            [],
            currentResults,
            mode,
        );
    }

    async function loadResults(query) {
        const sequence = ++requestSequence;
        try {
            const results = await SpotlightMessageClient.getSuggestions(query, mode);
            if (sequence !== requestSequence) return;
            asyncSuggestions = results || [];
            updateDisplay();
        } catch (error) {
            if (sequence !== requestSequence) return;
            Logger.error('[Spotlight] Search failed:', error);
            asyncSuggestions = [];
            updateDisplay();
        }
    }

    function handleInstantInput() {
        const query = input.value.trim();
        instantSuggestion = query
            ? SpotlightUtils.generateInstantSuggestion(query)
            : null;
        if (!query) asyncSuggestions = [];
        updateDisplay();
    }

    function handleAsyncSearch() {
        void loadResults(input.value.trim());
    }

    async function handleResultAction(result) {
        if (!result) return;
        try {
            onBeforeAction(result);
            await SpotlightMessageClient.handleResult(result, mode);
        } catch (error) {
            Logger.error('[Spotlight] Result action failed:', error);
        }
    }

    input.addEventListener('input', () => {
        handleInstantInput();
        handleAsyncSearch();
    });
    input.addEventListener(
        'keydown',
        SharedSpotlightLogic.createKeyDownHandler(
            selectionManager,
            handleResultAction,
            onEscape,
        ),
    );
    const relayKey = ({ key, code, altKey, ctrlKey, metaKey, shiftKey }) => {
        if ((key.length === 1 && !altKey && !ctrlKey && !metaKey) || key === 'Backspace' || key === 'Delete') {
            const start = input.selectionStart ?? input.value.length;
            const end = input.selectionEnd ?? start;
            if (key.length === 1) {
                input.setRangeText(key, start, end, 'end');
            } else if (start !== end) {
                input.setRangeText('', start, end, 'end');
            } else if (key === 'Backspace' && start > 0) {
                input.setRangeText('', start - 1, start, 'end');
            } else if (key === 'Delete' && start < input.value.length) {
                input.setRangeText('', start, start + 1, 'end');
            }
            input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
            return;
        }
        const navigationKey = key === 'Tab'
            ? (shiftKey ? 'ArrowUp' : 'ArrowDown')
            : key;
        input.dispatchEvent(new KeyboardEvent('keydown', {
            key: navigationKey,
            code,
            altKey,
            ctrlKey,
            metaKey,
            shiftKey,
            bubbles: true,
            cancelable: true,
        }));
    };
    SharedSpotlightLogic.setupResultClickHandling(
        resultsContainer,
        handleResultAction,
        () => currentResults,
    );

    input.value = initialValue;
    displayEmptyState();
    if (initialValue.trim()) handleInstantInput();
    void loadResults(initialValue.trim());
    focusSpotlightInput(input);

    return {
        focus: () => focusSpotlightInput(input),
        refresh: () => loadResults(input.value.trim()),
        relayKey,
    };
}
