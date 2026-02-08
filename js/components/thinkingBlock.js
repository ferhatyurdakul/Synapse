/**
 * ThinkingBlock - Collapsible component for AI thinking/reasoning content
 */

import { storageService } from '../services/storageService.js';
import { renderMarkdown } from '../utils/markdown.js';

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
        <span class="thinking-icon">💭</span>
        <span class="thinking-label">Thinking...</span>
        <span class="thinking-toggle">${collapsed ? '▶' : '▼'}</span>
    `;

    const body = document.createElement('div');
    body.className = 'thinking-body';
    body.innerHTML = `<div class="thinking-content">${renderMarkdown(content)}</div>`;

    wrapper.appendChild(header);
    wrapper.appendChild(body);

    // Toggle handler
    header.addEventListener('click', () => {
        const isCollapsed = wrapper.classList.toggle('collapsed');
        header.querySelector('.thinking-toggle').textContent = isCollapsed ? '▶' : '▼';

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
    const contentEl = block.querySelector('.thinking-content');
    if (contentEl) {
        contentEl.innerHTML = renderMarkdown(content);
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
