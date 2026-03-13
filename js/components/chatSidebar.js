/**
 * ChatSidebar - Sidebar component for chat management
 * Handles chat list, new chat, import/export
 */

import { chatService } from '../services/chatService.js?v=27';
import { providerManager } from '../services/providerManager.js?v=27';
import { eventBus, Events } from '../utils/eventBus.js?v=27';
import { openSettings } from './settingsPanel.js?v=27';
import { renderMarkdown } from '../utils/markdown.js?v=27';

class ChatSidebar {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.selectedModel = null;
        this.searchQuery = '';
        this.searchDebounceTimer = null;
        this.filtersVisible = false;
        this.filters = {
            provider: '',
            model: '',
            dateRange: '',
            containsCode: false,
            containsMath: false
        };
        this.collapsed = localStorage.getItem('sidebar-collapsed') === 'true';

        this.init();
    }

    init() {
        this.render();
        this.ensureExportModal();
        this.attachEvents();
        this.listenToEvents();
        this.refreshChatList();

        // Render Lucide icons in sidebar
        if (typeof lucide !== 'undefined') lucide.createIcons();
    }

    render() {
        this.container.innerHTML = `
            <div class="sidebar ${this.collapsed ? 'collapsed' : ''}">
                <div class="sidebar-header">
                    <h1 class="app-title">
                        <span class="title-icon">⟩</span>
                        <span class="title-text">Synapse</span>
                    </h1>
                    <button id="sidebar-toggle-btn" class="sidebar-toggle-btn" title="${this.collapsed ? 'Expand sidebar' : 'Collapse sidebar'}">
                        <i data-lucide="${this.collapsed ? 'panel-left-open' : 'panel-left-close'}" class="icon"></i>
                    </button>
                </div>
                
                <div class="sidebar-actions">
                    <button id="new-chat-btn" class="action-btn primary">
                        <span>+</span> New Chat
                    </button>
                </div>
                
                <div class="sidebar-search">
                    <div class="search-wrapper">
                        <span class="search-icon"><i data-lucide="search" class="icon"></i></span>
                        <input type="text" id="chat-search-input" class="search-input" placeholder="Search chats...">
                        <button id="search-clear-btn" class="search-clear-btn hidden" title="Clear search">×</button>
                        <button id="filter-toggle-btn" class="filter-toggle-btn" title="Toggle filters">
                            <span class="filter-icon"><i data-lucide="filter" class="icon"></i></span>
                        </button>
                    </div>
                    <div id="filter-panel" class="filter-panel hidden">
                        <div class="filter-flags">
                            <button class="filter-flag-btn" data-flag="code">
                                <i data-lucide="code" class="icon"></i> Code
                            </button>
                            <button class="filter-flag-btn" data-flag="math">
                                <i data-lucide="function-square" class="icon"></i> Math
                            </button>
                        </div>
                        <div class="filter-field">
                            <label>Provider</label>
                            <select id="filter-provider" class="filter-select">
                                <option value="">All</option>
                            </select>
                        </div>
                        <div class="filter-field">
                            <label>Model</label>
                            <select id="filter-model" class="filter-select">
                                <option value="">All</option>
                            </select>
                        </div>
                        <div class="filter-field full-width">
                            <label>Date</label>
                            <select id="filter-date" class="filter-select">
                                <option value="">All time</option>
                                <option value="today">Today</option>
                                <option value="week">This week</option>
                                <option value="month">This month</option>
                            </select>
                        </div>
                        <div class="filter-field full-width filter-actions">
                            <button id="filter-clear-btn" class="filter-clear-btn">Clear filters</button>
                        </div>
                    </div>
                </div>

                <div class="sidebar-section">
                    <div class="section-header">
                        <span>HISTORY</span>
                    </div>
                    <div id="chat-list" class="chat-list">
                        <!-- Chat items will be rendered here -->
                    </div>
                </div>
                
                <div class="sidebar-footer">
                    <button id="settings-btn" class="footer-btn" title="Settings">
                        <i data-lucide="settings" class="icon"></i> Settings
                    </button>
                    <button id="delete-all-btn" class="footer-btn danger" title="Delete all chats">
                        <i data-lucide="trash-2" class="icon"></i> Delete All
                    </button>
                    <div class="footer-row">
                        <button id="import-btn" class="footer-btn" title="Import chats">
                            <i data-lucide="download" class="icon"></i> Import
                        </button>
                        <button id="export-btn" class="footer-btn" title="Export current chat" disabled>
                            <i data-lucide="upload" class="icon"></i> Export
                        </button>
                    </div>
                </div>
                
                <input type="file" id="import-input" accept=".json" style="display: none;">
            </div>
        `;
    }

    attachEvents() {
        // Sidebar toggle
        document.getElementById('sidebar-toggle-btn').addEventListener('click', () => {
            this.toggleSidebar();
        });

        // New chat button
        document.getElementById('new-chat-btn').addEventListener('click', () => {
            this.createNewChat();
        });

        // Search input
        const searchInput = document.getElementById('chat-search-input');
        const clearBtn = document.getElementById('search-clear-btn');

        searchInput.addEventListener('input', (e) => {
            this.searchQuery = e.target.value.trim();
            clearBtn.classList.toggle('hidden', !this.searchQuery);

            // Debounce search for smooth typing
            clearTimeout(this.searchDebounceTimer);
            this.searchDebounceTimer = setTimeout(() => {
                this.refreshChatList();
            }, 150);
        });

        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                searchInput.value = '';
                this.searchQuery = '';
                clearBtn.classList.add('hidden');
                this.refreshChatList();
            }
        });

        clearBtn.addEventListener('click', () => {
            searchInput.value = '';
            this.searchQuery = '';
            clearBtn.classList.add('hidden');
            searchInput.focus();
            this.refreshChatList();
        });

        // Filter toggle
        const filterToggle = document.getElementById('filter-toggle-btn');
        filterToggle.addEventListener('click', () => {
            this.filtersVisible = !this.filtersVisible;
            document.getElementById('filter-panel').classList.toggle('hidden', !this.filtersVisible);
            filterToggle.classList.toggle('active', this.filtersVisible);
            if (this.filtersVisible) {
                this.populateFilterOptions();
                if (typeof lucide !== 'undefined') lucide.createIcons();
            }
        });

        // Filter change handlers
        ['filter-provider', 'filter-model', 'filter-date'].forEach(id => {
            document.getElementById(id).addEventListener('change', (e) => {
                const key = id.replace('filter-', '');
                this.filters[key] = e.target.value;
                this.updateFilterIndicator();
                this.refreshChatList();
            });
        });

        // Clear filters
        document.getElementById('filter-clear-btn').addEventListener('click', () => {
            this.filters = { provider: '', model: '', dateRange: '', containsCode: false, containsMath: false };
            document.getElementById('filter-provider').value = '';
            document.getElementById('filter-model').value = '';
            document.getElementById('filter-date').value = '';

            // Clear flag buttons UI
            document.querySelectorAll('.filter-flag-btn').forEach(btn => {
                btn.classList.remove('active');
            });

            this.updateFilterIndicator();
            this.refreshChatList();
        });

        // Filter flags (Code / Math)
        document.querySelectorAll('.filter-flag-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                // Toggle active UI state
                btn.classList.toggle('active');

                // Update internal filter state based on data-flag attribute
                const flag = btn.dataset.flag;
                if (flag === 'code') {
                    this.filters.containsCode = btn.classList.contains('active');
                } else if (flag === 'math') {
                    this.filters.containsMath = btn.classList.contains('active');
                }

                this.updateFilterIndicator();
                this.refreshChatList();
            });
        });

        // Import button
        document.getElementById('import-btn').addEventListener('click', () => {
            document.getElementById('import-input').click();
        });

        // Import file handler
        document.getElementById('import-input').addEventListener('change', (e) => {
            this.handleImport(e);
        });

        // Export button
        document.getElementById('export-btn').addEventListener('click', () => {
            this.openExportModal();
        });

        // Delete all button
        document.getElementById('delete-all-btn').addEventListener('click', () => {
            this.handleDeleteAll();
        });

        // Settings button
        document.getElementById('settings-btn').addEventListener('click', () => {
            openSettings();
        });
    }

    listenToEvents() {
        eventBus.on(Events.MODEL_CHANGED, ({ model }) => {
            this.selectedModel = model;
        });

        eventBus.on(Events.CHAT_CREATED, () => {
            this.refreshChatList();
            this.updateExportButtonState();
        });

        eventBus.on(Events.CHAT_DELETED, () => {
            this.refreshChatList();
            this.updateExportButtonState();
        });

        eventBus.on(Events.CHAT_UPDATED, () => {
            this.refreshChatList();
            this.updateExportButtonState();
        });

        eventBus.on(Events.CHATS_IMPORTED, () => {
            this.refreshChatList();
            this.updateExportButtonState();
        });

        eventBus.on(Events.CHAT_SELECTED, () => {
            this.updateExportButtonState();
        });
    }

    createNewChat() {
        // Fallback: read from the DOM selector if event hasn't fired yet
        if (!this.selectedModel) {
            const modelSelect = document.getElementById('model-select');
            if (modelSelect && modelSelect.value) {
                this.selectedModel = modelSelect.value;
            }
        }

        chatService.createChat(this.selectedModel || null);
    }

    toggleSidebar() {
        this.collapsed = !this.collapsed;
        localStorage.setItem('sidebar-collapsed', this.collapsed);

        const sidebar = this.container.querySelector('.sidebar');
        const toggleBtn = document.getElementById('sidebar-toggle-btn');

        sidebar.classList.toggle('collapsed', this.collapsed);
        toggleBtn.title = this.collapsed ? 'Expand sidebar' : 'Collapse sidebar';
        toggleBtn.innerHTML = `<i data-lucide="${this.collapsed ? 'panel-left-open' : 'panel-left-close'}" class="icon"></i>`;

        if (typeof lucide !== 'undefined') lucide.createIcons();
    }

    refreshChatList() {
        const listEl = document.getElementById('chat-list');
        let chats = chatService.getAllChats();
        const currentId = chatService.getCurrentChatId();
        const query = this.searchQuery.toLowerCase();

        // Apply filters first
        if (this.filters.provider) {
            chats = chats.filter(c => (c.provider || '').toLowerCase() === this.filters.provider.toLowerCase());
        }
        if (this.filters.model) {
            chats = chats.filter(c => c.model === this.filters.model);
        }
        if (this.filters.dateRange || this.filters.date) {
            const range = this.filters.dateRange || this.filters.date;
            const now = new Date();
            let cutoff;
            if (range === 'today') {
                cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            } else if (range === 'week') {
                cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            } else if (range === 'month') {
                cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            }
            if (cutoff) {
                chats = chats.filter(c => new Date(c.updatedAt || c.createdAt) >= cutoff);
            }
        }

        // Apply content flag filters
        if (this.filters.containsCode) {
            chats = chats.filter(chat => {
                return chat.messages.some(msg => msg.content && msg.content.includes('```'));
            });
        }
        if (this.filters.containsMath) {
            chats = chats.filter(chat => {
                // Look for typical math delimiters: $...$, \[...\], \(...\)
                return chat.messages.some(msg => {
                    if (!msg.content) return false;
                    return msg.content.includes('$') ||
                        msg.content.includes('\\[') ||
                        msg.content.includes('\\(');
                });
            });
        }

        // Text search
        let searchResults = null;
        if (query) {
            searchResults = new Map();
            chats = chats.filter(chat => {
                // Match title
                if (chat.title.toLowerCase().includes(query)) {
                    searchResults.set(chat.id, { type: 'title' });
                    return true;
                }
                // Match message content
                for (const msg of chat.messages) {
                    if (msg.content && msg.content.toLowerCase().includes(query)) {
                        // Get snippet around match
                        const idx = msg.content.toLowerCase().indexOf(query);
                        const start = Math.max(0, idx - 30);
                        const end = Math.min(msg.content.length, idx + query.length + 30);
                        let snippet = msg.content.substring(start, end).replace(/\n/g, ' ');
                        if (start > 0) snippet = '...' + snippet;
                        if (end < msg.content.length) snippet += '...';
                        searchResults.set(chat.id, { type: 'message', snippet, role: msg.role });
                        return true;
                    }
                }
                return false;
            });
        }

        if (chats.length === 0) {
            listEl.innerHTML = query
                ? `<div class="empty-state">No results for "${this.escapeHtml(query)}"</div>`
                : `<div class="empty-state">No chats yet.<br>Click "New Chat" to start.</div>`;
            return;
        }

        listEl.innerHTML = chats.map(chat => {
            const title = query
                ? this.highlightMatch(this.escapeHtml(chat.title), query)
                : this.escapeHtml(chat.title);

            // Build snippet line for message matches
            let snippetHtml = '';
            if (searchResults && searchResults.has(chat.id)) {
                const result = searchResults.get(chat.id);
                if (result.type === 'message' && result.snippet) {
                    const highlighted = this.highlightMatch(this.escapeHtml(result.snippet), query);
                    snippetHtml = `<div class="chat-search-snippet">${highlighted}</div>`;
                }
            }

            return `
                <div class="chat-item ${chat.id === currentId ? 'active' : ''}" data-id="${chat.id}">
                    <div class="chat-item-content">
                        <span class="chat-icon">💬</span>
                        <div class="chat-item-text">
                            <span class="chat-title">${title}</span>
                            ${snippetHtml}
                        </div>
                    </div>
                    <button class="delete-chat-btn" data-id="${chat.id}" title="Delete chat">×</button>
                </div>
            `;
        }).join('');

        // Attach click handlers
        listEl.querySelectorAll('.chat-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (!e.target.classList.contains('delete-chat-btn')) {
                    chatService.selectChat(item.dataset.id);
                    this.refreshChatList();
                }
            });
        });

        // Attach delete handlers
        listEl.querySelectorAll('.delete-chat-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                chatService.deleteChat(btn.dataset.id);
            });
        });
    }

    highlightMatch(text, query) {
        if (!query) return text;
        const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
        return text.replace(regex, '<mark class="search-highlight">$1</mark>');
    }

    populateFilterOptions() {
        const allChats = chatService.getAllChats();
        const providers = new Set();
        const models = new Set();

        allChats.forEach(chat => {
            if (chat.provider) providers.add(chat.provider);
            if (chat.model) models.add(chat.model);
        });

        const providerSelect = document.getElementById('filter-provider');
        const curProvider = this.filters.provider;
        providerSelect.innerHTML = '<option value="">All</option>' +
            [...providers].sort().map(p =>
                `<option value="${p}" ${p === curProvider ? 'selected' : ''}>${p}</option>`
            ).join('');

        const modelSelect = document.getElementById('filter-model');
        const curModel = this.filters.model;
        modelSelect.innerHTML = '<option value="">All</option>' +
            [...models].sort().map(m =>
                `<option value="${m}" ${m === curModel ? 'selected' : ''}>${m}</option>`
            ).join('');
    }

    updateFilterIndicator() {
        const hasActive = this.filters.provider ||
            this.filters.model ||
            this.filters.date ||
            this.filters.dateRange ||
            this.filters.containsCode ||
            this.filters.containsMath;
        document.getElementById('filter-toggle-btn').classList.toggle('has-filters', !!hasActive);
    }

    handleImport(e) {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                chatService.importChats(event.target.result);
            } catch (error) {
                console.error('Failed to import chats:', error.message);
            }
        };
        reader.readAsText(file);

        // Reset input
        e.target.value = '';
    }

    ensureExportModal() {
        if (document.getElementById('export-modal')) return;

        const modal = document.createElement('div');
        modal.id = 'export-modal';
        modal.className = 'settings-modal hidden';
        modal.innerHTML = `
            <div class="settings-overlay" id="export-overlay"></div>
            <div class="settings-panel">
                <div class="settings-header">
                    <h2>Export / Import</h2>
                    <button class="settings-close-btn" id="export-close-btn">×</button>
                </div>
                <div class="settings-content">
                    <div class="settings-section">
                        <h3>Export format</h3>
                        <div class="settings-field">
                            <label for="export-format-select">Format</label>
                            <select id="export-format-select" class="settings-select">
                                <option value="json">JSON</option>
                                <option value="md">Markdown</option>
                                <option value="html">HTML (rendered)</option>
                            </select>
                        </div>
                        <div class="settings-field">
                            <label class="checkbox-label">
                                <input type="checkbox" id="export-include-thinking" checked />
                                Include thinking blocks
                            </label>
                        </div>
                        <div class="settings-actions">
                            <button id="export-download-btn" class="action-btn primary">Export current chat</button>
                        </div>
                    </div>

                </div>
            </div>
        `;

        document.body.appendChild(modal);

        document.getElementById('export-overlay').addEventListener('click', () => this.closeExportModal());
        document.getElementById('export-close-btn').addEventListener('click', () => this.closeExportModal());
        document.getElementById('export-download-btn').addEventListener('click', () => this.handleExportDownload());

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeExportModal();
            }
        });
    }

    openExportModal() {
        const currentChat = chatService.getCurrentChat();
        if (!currentChat || currentChat.messages.length === 0) return;
        document.getElementById('export-modal')?.classList.remove('hidden');
    }

    closeExportModal() {
        document.getElementById('export-modal')?.classList.add('hidden');
    }

    buildChatMarkdown(chat, includeThinking = true) {
        const lines = [];
        const created = chat.createdAt ? new Date(chat.createdAt).toISOString() : '';
        lines.push(`# ${chat.title || 'Chat'}`);
        if (created) lines.push(`_Created: ${created}_`);
        lines.push('');

        for (const msg of chat.messages) {
            const role = msg.role || 'unknown';
            const headerRole = role === 'user' ? 'User' : (role === 'assistant' ? 'Assistant' : role);
            lines.push(`## ${headerRole}`);

            if (includeThinking && msg.thinking) {
                lines.push('');
                lines.push('```thinking');
                lines.push(String(msg.thinking).trim());
                lines.push('```');
            }

            lines.push('');
            lines.push(String(msg.content || '').trim());
            lines.push('');
        }

        return lines.join('\n');
    }

    buildChatHtml(chat, includeThinking = true) {
        const title = this.escapeHtml(chat.title || 'Chat Export');
        const blocks = [];

        for (const msg of chat.messages) {
            const role = msg.role || 'unknown';
            const who = role === 'user' ? 'You' : 'Assistant';
            const contentHtml = renderMarkdown(String(msg.content || ''));

            let thinkingHtml = '';
            if (includeThinking && msg.thinking) {
                thinkingHtml = `
                    <details class="export-thinking">
                      <summary>Thinking</summary>
                      <pre>${this.escapeHtml(String(msg.thinking).trim())}</pre>
                    </details>
                `;
            }

            blocks.push(`
                <div class="export-message export-${role}">
                    <div class="export-meta">${this.escapeHtml(who)}</div>
                    ${thinkingHtml}
                    <div class="export-content">${contentHtml}</div>
                </div>
            `);
        }

        // Minimal standalone HTML with existing CSS variables fallback
        return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif; background:#0b1220; color:#e5e7eb; padding:24px;}
    .export-container{max-width:900px; margin:0 auto;}
    h1{color:#22d3ee; margin:0 0 16px 0;}
    .export-message{border:1px solid rgba(255,255,255,0.12); border-radius:10px; padding:12px 14px; margin:12px 0; background:rgba(255,255,255,0.03)}
    .export-meta{font-size:12px; opacity:0.8; margin-bottom:8px;}
    .export-content :is(pre,code){background:rgba(0,0,0,0.35);}
    .export-thinking summary{cursor:pointer; font-size:12px; opacity:0.85;}
    .export-thinking pre{white-space:pre-wrap; background:rgba(0,0,0,0.35); padding:10px; border-radius:8px;}
    a{color:#60a5fa}
    @media print{body{background:#fff;color:#000} .export-message{border:1px solid #ddd; background:#fff} h1{color:#000} a{color:#000}}
  </style>
</head>
<body>
  <div class="export-container">
    <h1>${title}</h1>
    ${blocks.join('\n')}
  </div>
</body>
</html>`;
    }

    downloadBlob(content, mimeType, filename) {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    handleExportDownload() {
        const currentChat = chatService.getCurrentChat();
        if (!currentChat || currentChat.messages.length === 0) return;

        const format = document.getElementById('export-format-select')?.value || 'json';
        const includeThinking = !!document.getElementById('export-include-thinking')?.checked;

        const safeTitle = (currentChat.title || 'chat').replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
        const date = new Date().toISOString().split('T')[0];

        if (format === 'json') {
            let jsonStr = chatService.exportChat(currentChat.id);

            // Apply includeThinking toggle to JSON as well
            if (!includeThinking) {
                try {
                    const data = JSON.parse(jsonStr);
                    const chatId = Object.keys(data)[0];
                    const chat = data[chatId];
                    if (chat && Array.isArray(chat.messages)) {
                        chat.messages = chat.messages.map(m => {
                            const copy = { ...m };
                            delete copy.thinking;
                            return copy;
                        });
                    }
                    jsonStr = JSON.stringify(data, null, 2);
                } catch (e) {
                    console.warn('Failed to strip thinking from JSON export:', e);
                }
            }

            this.downloadBlob(jsonStr, 'application/json', `chat-${safeTitle}-${date}.json`);
            this.closeExportModal();
            return;
        }

        if (format === 'md') {
            const md = this.buildChatMarkdown(currentChat, includeThinking);
            this.downloadBlob(md, 'text/markdown', `chat-${safeTitle}-${date}.md`);
            this.closeExportModal();
            return;
        }

        const html = this.buildChatHtml(currentChat, includeThinking);

        if (format === 'html') {
            this.downloadBlob(html, 'text/html', `chat-${safeTitle}-${date}.html`);
            this.closeExportModal();
            return;
        }

        // PDF strategy: open a new window and trigger browser print-to-pdf
        const w = window.open('', '_blank');
        if (!w) {
            console.warn('Popup blocked. Allow popups to export PDF.');
            return;
        }
        w.document.open();
        w.document.write(html);
        w.document.close();
        w.focus();
        // Give the browser a moment to render
        setTimeout(() => {
            w.print();
        }, 250);
        this.closeExportModal();
    }

    updateExportButtonState() {
        const exportBtn = document.getElementById('export-btn');
        const currentChat = chatService.getCurrentChat();
        const hasMessages = currentChat && currentChat.messages.length > 0;

        exportBtn.disabled = !hasMessages;
        exportBtn.title = hasMessages ? 'Export current chat' : 'No chat to export';
    }

    handleDeleteAll() {
        const chats = chatService.getAllChats();
        if (chats.length === 0) {
            return;
        }

        chatService.deleteAllChats();
        this.refreshChatList();
        this.updateExportButtonState();
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

export function createChatSidebar(containerId) {
    return new ChatSidebar(containerId);
}
