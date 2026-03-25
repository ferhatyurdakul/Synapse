/**
 * ThinkingBlock - Collapsible component for AI thinking/reasoning content
 */

import { storageService } from '../services/storageService.js?v=35';
import { renderMarkdown } from '../utils/markdown.js?v=35';

/**
 * Create a thinking block element
 * @param {string} content - Thinking content
 * @param {boolean} collapsed - Initial collapsed state
 * @returns {HTMLElement}
 */
export function createThinkingBlock(content, collapsed = true) {
    const wrapper = document.createElement('div');
    wrapper.className = `thinking-block ${collapsed ? 'collapsed' : ''}`;

    const header = document.createElement('div');
    header.className = 'thinking-header';
    header.innerHTML = `
        <span class="thinking-label">Thinking...</span>
        <span class="thinking-actions">
            <button class="thinking-copy-btn" title="Copy thinking" aria-label="Copy thinking"><i data-lucide="copy" class="icon"></i></button>
            <span class="thinking-toggle"><i data-lucide="${collapsed ? 'chevron-right' : 'chevron-down'}" class="icon"></i></span>
        </span>
    `;

    const body = document.createElement('div');
    body.className = 'thinking-body';
    body.innerHTML = `<div class="thinking-content">${renderMarkdown(content)}</div>`;

    wrapper.appendChild(header);
    wrapper.appendChild(body);

    // Track whether the user has scrolled up within the thinking body
    body._userScrolledUp = false;
    body.addEventListener('scroll', () => {
        const threshold = 40;
        const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight <= threshold;
        body._userScrolledUp = !atBottom;
    });

    // Copy handler
    header.querySelector('.thinking-copy-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        const text = body.querySelector('.thinking-content')?.innerText || '';
        navigator.clipboard.writeText(text).then(() => {
            const icon = header.querySelector('.thinking-copy-btn .icon');
            if (icon) {
                icon.setAttribute('data-lucide', 'check');
                refreshIcons();
                setTimeout(() => {
                    icon.setAttribute('data-lucide', 'copy');
                    refreshIcons();
                }, 1500);
            }
        });
    });

    // Toggle handler
    header.addEventListener('click', () => {
        const isCollapsed = wrapper.classList.toggle('collapsed');
        const toggle = header.querySelector('.thinking-toggle');
        toggle.innerHTML = `<i data-lucide="${isCollapsed ? 'chevron-right' : 'chevron-down'}" class="icon"></i>`;
        refreshIcons();

        // Save preference
        const settings = storageService.loadSettings();
        settings.thinkingCollapsed = isCollapsed;
        storageService.saveSettings(settings);
    });

    return wrapper;
}

/**
 * Update existing thinking block content (for streaming)
 * @param {HTMLElement} block - Existing thinking block
 * @param {string} content - New content
 */
export function updateThinkingBlock(block, content) {
    const body = block.querySelector('.thinking-body');
    const contentEl = block.querySelector('.thinking-content');
    if (!contentEl) return;

    contentEl.innerHTML = renderMarkdown(content);

    // Auto-scroll to bottom unless the user has scrolled up
    if (body && !body._userScrolledUp) {
        body.scrollTop = body.scrollHeight;
    }
}

/**
 * Check if thinking should be collapsed by default
 * @returns {boolean}
 */
export function getDefaultCollapsedState() {
    const settings = storageService.loadSettings();
    return settings.thinkingCollapsed !== false; // Default to true
}
