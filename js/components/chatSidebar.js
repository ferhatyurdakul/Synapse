/**
 * ChatSidebar - Sidebar component for chat management
 * Handles chat list, new chat, import/export
 */

import { chatService } from '../services/chatService.js';
import { storageService } from '../services/storageService.js';
import { providerManager } from '../services/providerManager.js';
import { eventBus, Events } from '../utils/eventBus.js';
import { openSettings } from './settingsPanel.js';
import { renderMarkdown, escapeHtml } from '../utils/markdown.js';
import { toast } from './toast.js';

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
            containsMath: false,
            containsImages: false,
            containsDocs: false,
            containsSearch: false
        };
        this.collapsed = storageService.loadSidebarState();

        this.init();
    }

    init() {
        this.render();
        this.ensureExportModal();
        this.attachEvents();
        this.listenToEvents();
        this.refreshChatList();

        // Render Lucide icons in sidebar
        refreshIcons();
    }

    render() {
        this.container.innerHTML = `
            <div class="sidebar ${this.collapsed ? 'collapsed' : ''}">
                <div class="sidebar-header">
                    <h1 class="app-title">
                        <span class="title-icon">⟩</span>
                        <span class="title-text">Synapse</span>
                    </h1>
                    <button id="sidebar-toggle-btn" class="sidebar-toggle-btn" title="${this.collapsed ? 'Expand sidebar' : 'Collapse sidebar'}" aria-label="${this.collapsed ? 'Expand sidebar' : 'Collapse sidebar'}">
                        <i data-lucide="${this.collapsed ? 'panel-left-open' : 'panel-left-close'}" class="icon"></i>
                    </button>
                </div>
                
                <div class="sidebar-actions">
                    <button id="new-chat-btn" class="action-btn primary">
                        <i data-lucide="plus" class="icon"></i> New Chat
                    </button>
                </div>
                
                <div class="sidebar-search">
                    <div class="search-wrapper">
                        <span class="search-icon"><i data-lucide="search" class="icon"></i></span>
                        <input type="text" id="chat-search-input" class="search-input" placeholder="Search chats...">
                        <button id="search-clear-btn" class="search-clear-btn hidden" title="Clear search" aria-label="Clear search"><i data-lucide="x" class="icon"></i></button>
                        <button id="filter-toggle-btn" class="filter-toggle-btn" title="Toggle filters" aria-label="Toggle filters">
                            <span class="filter-icon"><i data-lucide="filter" class="icon"></i></span>
                        </button>
                        <button id="filter-clear-btn" class="filter-clear-btn hidden" title="Clear filters" aria-label="Clear filters"><i data-lucide="x" class="icon"></i></button>
                    </div>
                    <div id="filter-panel" class="filter-panel hidden">
                        <div class="filter-flags">
                            <button class="filter-flag-btn" data-flag="code">
                                <i data-lucide="code" class="icon"></i> Code
                            </button>
                            <button class="filter-flag-btn" data-flag="math">
                                <i data-lucide="function-square" class="icon"></i> Math
                            </button>
                            <button class="filter-flag-btn" data-flag="search">
                                <i data-lucide="globe" class="icon"></i> Search
                            </button>
                        </div>
                        <div class="filter-flags">
                            <button class="filter-flag-btn" data-flag="images">
                                <i data-lucide="image" class="icon"></i> Images
                            </button>
                            <button class="filter-flag-btn" data-flag="docs">
                                <i data-lucide="file-text" class="icon"></i> Docs
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
                    </div>
                </div>

                <div class="sidebar-section">
                    <div class="section-header">
                        <span>HISTORY</span>
                        <button id="add-folder-btn" class="section-header-btn" title="New folder" aria-label="New folder">
                            <i data-lucide="folder-plus" class="icon"></i>
                        </button>
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
        // Close export modal on Escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.closeExportModal();
        });

        // Sidebar toggle
        document.getElementById('sidebar-toggle-btn').addEventListener('click', () => {
            this.toggleSidebar();
        });

        // New chat button
        document.getElementById('new-chat-btn').addEventListener('click', () => {
            this.createNewChat();
        });

        // New folder button
        document.getElementById('add-folder-btn').addEventListener('click', () => {
            this.createNewFolder();
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
                refreshIcons();
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
            this.filters = { provider: '', model: '', dateRange: '', containsCode: false, containsMath: false, containsImages: false, containsDocs: false, containsSearch: false };
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
                const active = btn.classList.contains('active');
                if (flag === 'code') this.filters.containsCode = active;
                else if (flag === 'math') this.filters.containsMath = active;
                else if (flag === 'images') this.filters.containsImages = active;
                else if (flag === 'docs') this.filters.containsDocs = active;
                else if (flag === 'search') this.filters.containsSearch = active;

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
        storageService.saveSidebarState(this.collapsed);

        const sidebar = this.container.querySelector('.sidebar');
        const toggleBtn = document.getElementById('sidebar-toggle-btn');

        sidebar.classList.toggle('collapsed', this.collapsed);
        toggleBtn.title = this.collapsed ? 'Expand sidebar' : 'Collapse sidebar';
        toggleBtn.innerHTML = `<i data-lucide="${this.collapsed ? 'panel-left-open' : 'panel-left-close'}" class="icon"></i>`;

        refreshIcons();
    }

    refreshChatList() {
        const listEl = document.getElementById('chat-list');
        let chats = chatService.getAllChats();
        const currentId = chatService.getCurrentChatId();
        const query = this.searchQuery.toLowerCase();

        // Apply filters
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
            if (range === 'today') cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            else if (range === 'week') cutoff = new Date(now.getTime() - 7 * 86400000);
            else if (range === 'month') cutoff = new Date(now.getTime() - 30 * 86400000);
            if (cutoff) chats = chats.filter(c => new Date(c.updatedAt || c.createdAt) >= cutoff);
        }
        if (this.filters.containsCode) {
            chats = chats.filter(chat => chat.messages.some(msg => msg.content && msg.content.includes('```')));
        }
        if (this.filters.containsMath) {
            chats = chats.filter(chat => chat.messages.some(msg => {
                if (!msg.content) return false;
                return msg.content.includes('$') || msg.content.includes('\\[') || msg.content.includes('\\(');
            }));
        }
        if (this.filters.containsImages) {
            chats = chats.filter(chat => chat.messages.some(msg => msg.images && msg.images.length > 0));
        }
        if (this.filters.containsDocs) {
            chats = chats.filter(chat => chat.messages.some(msg => msg.documents && msg.documents.length > 0));
        }
        if (this.filters.containsSearch) {
            chats = chats.filter(chat => chat.messages.some(msg => msg.role === 'tool' && msg.toolName && msg.toolName.toLowerCase().includes('search')));
        }

        // Text search
        let searchResults = null;
        if (query) {
            searchResults = new Map();
            chats = chats.filter(chat => {
                if (chat.title.toLowerCase().includes(query)) {
                    searchResults.set(chat.id, { type: 'title' });
                    return true;
                }
                for (const msg of chat.messages) {
                    if (msg.content && msg.content.toLowerCase().includes(query)) {
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
                ? `<div class="empty-state">No results for "${escapeHtml(query)}"</div>`
                : `<div class="empty-state">No chats yet.<br>Click "New Chat" to start.</div>`;
            return;
        }

        // Group chats by folder
        const folders = chatService.getAllFolders();
        const folderChats = new Map(); // folderId -> chats[]
        const unfolderedChats = [];

        for (const chat of chats) {
            if (chat.folderId && chatService.getFolder(chat.folderId)) {
                if (!folderChats.has(chat.folderId)) folderChats.set(chat.folderId, []);
                folderChats.get(chat.folderId).push(chat);
            } else {
                unfolderedChats.push(chat);
            }
        }

        // Build folder context menu options
        const folderMenuOptions = folders.map(f =>
            `<div class="folder-menu-item" data-folder-id="${f.id}">${escapeHtml(f.name)}</div>`
        ).join('');

        let html = '';

        // Render folders (only those with matching chats, or all if no search)
        for (const folder of folders) {
            const fChats = folderChats.get(folder.id) || [];
            // When searching, skip empty folders
            if (query && fChats.length === 0) continue;

            html += `
                <div class="folder-group" data-folder-id="${folder.id}">
                    <div class="folder-header ${folder.collapsed && !query ? 'collapsed' : ''}">
                        <div class="folder-header-left">
                            <i data-lucide="chevron-right" class="icon folder-chevron"></i>
                            <i data-lucide="folder" class="icon folder-icon"></i>
                            <span class="folder-name">${escapeHtml(folder.name)}</span>
                            <span class="folder-count">${fChats.length}</span>
                        </div>
                        <div class="folder-actions">
                            <button class="folder-action-btn newchat-folder-btn" data-folder-id="${folder.id}" title="New chat in folder" aria-label="New chat in folder"><i data-lucide="plus" class="icon"></i></button>
                            <button class="folder-action-btn sysprompt-folder-btn" data-folder-id="${folder.id}" title="System prompt" aria-label="System prompt"><i data-lucide="message-square-text" class="icon"></i></button>
                            <button class="folder-action-btn rename-folder-btn" data-folder-id="${folder.id}" title="Rename folder" aria-label="Rename folder"><i data-lucide="pencil" class="icon"></i></button>
                            <button class="folder-action-btn delete-folder-btn" data-folder-id="${folder.id}" title="Delete folder" aria-label="Delete folder"><i data-lucide="x" class="icon"></i></button>
                        </div>
                    </div>
                    <div class="folder-contents ${folder.collapsed && !query ? 'hidden' : ''}">
                        ${fChats.map(chat => this.renderChatItem(chat, currentId, query, searchResults, folderMenuOptions)).join('')}
                    </div>
                </div>
            `;
        }

        // Render unfoldered chats
        html += unfolderedChats.map(chat => this.renderChatItem(chat, currentId, query, searchResults, folderMenuOptions)).join('');

        listEl.innerHTML = html;
        this.attachChatItemHandlers(listEl);
        this.attachFolderHandlers(listEl);

        refreshIcons();
    }

    renderChatItem(chat, currentId, query, searchResults, folderMenuOptions) {
        const title = query
            ? this.highlightMatch(escapeHtml(chat.title), query)
            : escapeHtml(chat.title);

        let snippetHtml = '';
        if (searchResults && searchResults.has(chat.id)) {
            const result = searchResults.get(chat.id);
            if (result.type === 'message' && result.snippet) {
                const highlighted = this.highlightMatch(escapeHtml(result.snippet), query);
                snippetHtml = `<div class="chat-search-snippet">${highlighted}</div>`;
            }
        }

        return `
            <div class="chat-item ${chat.id === currentId ? 'active' : ''}" data-id="${chat.id}" draggable="true">
                <div class="chat-item-content">
                    <div class="chat-item-text">
                        <span class="chat-title">${title}</span>
                        ${snippetHtml}
                    </div>
                </div>
                <div class="chat-item-actions">
                    <button class="move-chat-btn" data-id="${chat.id}" title="Move to folder" aria-label="Move to folder"><i data-lucide="folder-input" class="icon"></i></button>
                    <button class="rename-chat-btn" data-id="${chat.id}" title="Rename chat" aria-label="Rename chat"><i data-lucide="pencil" class="icon"></i></button>
                    <button class="delete-chat-btn" data-id="${chat.id}" title="Delete chat" aria-label="Delete chat"><i data-lucide="x" class="icon"></i></button>
                </div>
            </div>
        `;
    }

    attachChatItemHandlers(listEl) {
        // Click to select
        listEl.querySelectorAll('.chat-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (!e.target.closest('.chat-item-actions') && !e.target.closest('.folder-menu')) {
                    chatService.selectChat(item.dataset.id);
                    this.refreshChatList();
                }
            });

            // Drag support
            item.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', item.dataset.id);
                e.dataTransfer.effectAllowed = 'move';
                item.classList.add('dragging');
            });
            item.addEventListener('dragend', () => item.classList.remove('dragging'));
        });

        // Rename handlers
        listEl.querySelectorAll('.rename-chat-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.startRename(btn.dataset.id);
            });
        });

        // Delete handlers
        listEl.querySelectorAll('.delete-chat-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const chatId = btn.dataset.id;
                const chat = chatService.getAllChats().find(c => c.id === chatId);
                const chatTitle = chat?.title || 'Untitled chat';
                this.showConfirmDialog(
                    'Delete Chat',
                    `Delete "${escapeHtml(chatTitle)}"? This cannot be undone.`,
                    () => chatService.deleteChat(chatId)
                );
            });
        });

        // Move-to-folder handlers
        listEl.querySelectorAll('.move-chat-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.showFolderMenu(btn.dataset.id, btn);
            });
        });
    }

    attachFolderHandlers(listEl) {
        // Folder toggle
        listEl.querySelectorAll('.folder-header').forEach(header => {
            header.addEventListener('click', (e) => {
                if (e.target.closest('.folder-actions')) return;
                const folderId = header.closest('.folder-group').dataset.folderId;
                chatService.toggleFolderCollapsed(folderId);
                header.classList.toggle('collapsed');
                const contents = header.nextElementSibling;
                contents.classList.toggle('hidden');
            });
        });

        // Folder rename
        listEl.querySelectorAll('.rename-folder-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.startFolderRename(btn.dataset.folderId);
            });
        });

        // New chat in folder
        listEl.querySelectorAll('.newchat-folder-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const folderId = btn.dataset.folderId;
                if (!this.selectedModel) {
                    toast.warning('Select a model first');
                    return;
                }
                const chatId = chatService.createChat(this.selectedModel);
                chatService.moveChatToFolder(chatId, folderId);
                chatService.selectChat(chatId);
            });
        });

        // Folder system prompt
        listEl.querySelectorAll('.sysprompt-folder-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.showFolderSystemPrompt(btn.dataset.folderId);
            });
        });

        // Folder delete
        listEl.querySelectorAll('.delete-folder-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const folderId = btn.dataset.folderId;
                const folder = chatService.getFolder(folderId);
                this.showConfirmDialog(
                    'Delete Folder',
                    `Delete folder "${escapeHtml(folder?.name || '')}"? Chats inside will be moved to the root list.`,
                    () => chatService.deleteFolder(folderId)
                );
            });
        });

        // Folder drop targets
        listEl.querySelectorAll('.folder-group').forEach(group => {
            const header = group.querySelector('.folder-header');
            header.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                header.classList.add('drag-over');
            });
            header.addEventListener('dragleave', () => header.classList.remove('drag-over'));
            header.addEventListener('drop', (e) => {
                e.preventDefault();
                header.classList.remove('drag-over');
                const chatId = e.dataTransfer.getData('text/plain');
                const folderId = group.dataset.folderId;
                if (chatId) {
                    chatService.moveChatToFolder(chatId, folderId);
                }
            });
        });

        // Root drop target (unfoldered area)
        listEl.addEventListener('dragover', (e) => {
            if (e.target.closest('.folder-group')) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
        });
        listEl.addEventListener('drop', (e) => {
            if (e.target.closest('.folder-group')) return;
            e.preventDefault();
            const chatId = e.dataTransfer.getData('text/plain');
            if (chatId) {
                chatService.moveChatToFolder(chatId, null);
            }
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
            this.filters.containsMath ||
            this.filters.containsImages ||
            this.filters.containsDocs ||
            this.filters.containsSearch;
        document.getElementById('filter-toggle-btn').classList.toggle('has-filters', !!hasActive);
        document.getElementById('filter-clear-btn').classList.toggle('hidden', !hasActive);
    }

    handleImport(e) {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (event) => {
            try {
                await chatService.importChats(event.target.result);
                toast.success(`Chats imported successfully`);
            } catch (error) {
                console.error('Failed to import chats:', error.message);
                toast.error(`Failed to import: ${error.message}`);
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
        modal.className = 'export-modal hidden';
        modal.innerHTML = `
            <div class="export-overlay" id="export-overlay"></div>
            <div class="export-panel">
                <div class="export-header">
                    <h2>Export Chat</h2>
                    <button class="export-close-btn" id="export-close-btn" title="Close" aria-label="Close"><i data-lucide="x" class="icon"></i></button>
                </div>
                <div class="export-body">
                    <div class="export-field">
                        <label for="export-format-select">Format</label>
                        <select id="export-format-select" class="export-select">
                            <option value="json">JSON</option>
                            <option value="md">Markdown</option>
                            <option value="html">HTML (rendered)</option>
                        </select>
                    </div>
                    <label class="export-toggle">
                        <span class="export-toggle-label">Include thinking blocks</span>
                        <input type="checkbox" id="export-include-thinking" checked />
                        <span class="export-toggle-track"><span class="export-toggle-thumb"></span></span>
                    </label>
                </div>
                <div class="export-footer">
                    <button id="export-download-btn" class="export-btn">
                        <i data-lucide="download" class="icon"></i> Export
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        refreshIcons();

        document.getElementById('export-overlay').addEventListener('click', () => this.closeExportModal());
        document.getElementById('export-close-btn').addEventListener('click', () => this.closeExportModal());
        document.getElementById('export-download-btn').addEventListener('click', () => this.handleExportDownload());

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
        const title = escapeHtml(chat.title || 'Chat Export');
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
                      <pre>${escapeHtml(String(msg.thinking).trim())}</pre>
                    </details>
                `;
            }

            blocks.push(`
                <div class="export-message export-${role}">
                    <div class="export-meta">${escapeHtml(who)}</div>
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
            toast.success('Chat exported as JSON');
            return;
        }

        if (format === 'md') {
            const md = this.buildChatMarkdown(currentChat, includeThinking);
            this.downloadBlob(md, 'text/markdown', `chat-${safeTitle}-${date}.md`);
            this.closeExportModal();
            toast.success('Chat exported as Markdown');
            return;
        }

        if (format === 'html') {
            const html = this.buildChatHtml(currentChat, includeThinking);
            this.downloadBlob(html, 'text/html', `chat-${safeTitle}-${date}.html`);
            this.closeExportModal();
            toast.success('Chat exported as HTML');
        }
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

        this.showConfirmDialog(
            'Delete All Chats',
            `Are you sure you want to delete all ${chats.length} chat${chats.length > 1 ? 's' : ''}? This action cannot be undone.`,
            () => {
                chatService.deleteAllChats();
                this.refreshChatList();
                this.updateExportButtonState();
            }
        );
    }

    showConfirmDialog(title, message, onConfirm) {
        // Remove existing dialog if any
        const existing = document.getElementById('confirm-dialog');
        if (existing) existing.remove();

        const dialog = document.createElement('div');
        dialog.id = 'confirm-dialog';
        dialog.className = 'confirm-dialog';
        dialog.innerHTML = `
            <div class="confirm-overlay"></div>
            <div class="confirm-panel">
                <h3 class="confirm-title">${title}</h3>
                <p class="confirm-message">${message}</p>
                <div class="confirm-actions">
                    <button class="confirm-btn cancel">Cancel</button>
                    <button class="confirm-btn danger">Delete</button>
                </div>
            </div>
        `;

        document.body.appendChild(dialog);

        const close = () => dialog.remove();

        dialog.querySelector('.confirm-overlay').addEventListener('click', close);
        dialog.querySelector('.confirm-btn.cancel').addEventListener('click', close);
        dialog.querySelector('.confirm-btn.danger').addEventListener('click', () => {
            close();
            onConfirm();
        });

        // Escape key closes
        const onKey = (e) => {
            if (e.key === 'Escape') {
                close();
                document.removeEventListener('keydown', onKey);
            }
        };
        document.addEventListener('keydown', onKey);

        // Focus the cancel button by default (safe option)
        dialog.querySelector('.confirm-btn.cancel').focus();
    }

    startRename(chatId) {
        const item = document.querySelector(`.chat-item[data-id="${chatId}"]`);
        if (!item) return;
        const titleEl = item.querySelector('.chat-title');
        if (!titleEl) return;

        const currentTitle = chatService.getAllChats().find(c => c.id === chatId)?.title || '';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'chat-title-input';
        input.value = currentTitle;
        titleEl.replaceWith(input);
        input.focus();
        input.select();

        let committed = false;

        const commit = () => {
            if (committed) return;
            committed = true;
            const newTitle = input.value.trim();
            if (newTitle && newTitle !== currentTitle) {
                chatService.updateChatTitle(chatId, newTitle);
            } else {
                this.refreshChatList();
            }
        };

        const cancel = () => {
            if (committed) return;
            committed = true;
            this.refreshChatList();
        };

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        });
        input.addEventListener('blur', commit);
        input.addEventListener('click', (e) => e.stopPropagation());
    }

    createNewFolder() {
        const id = chatService.createFolder('New Folder');
        // Immediately start rename on the new folder
        requestAnimationFrame(() => this.startFolderRename(id));
    }

    showFolderSystemPrompt(folderId) {
        const folder = chatService.getFolder(folderId);
        if (!folder) return;

        const group = document.querySelector(`.folder-group[data-folder-id="${folderId}"]`);
        if (!group) return;

        // Toggle off if already showing
        const existing = group.querySelector('.folder-sysprompt-editor');
        if (existing) { existing.remove(); return; }

        const editor = document.createElement('div');
        editor.className = 'folder-sysprompt-editor';
        editor.innerHTML = `
            <textarea class="folder-sysprompt-textarea" rows="3"
                placeholder="System prompt for this folder (overrides global)">${escapeHtml(folder.systemPrompt || '')}</textarea>
            <div class="folder-sysprompt-actions">
                <button class="folder-sysprompt-save">Save</button>
                <button class="folder-sysprompt-cancel">Cancel</button>
            </div>
        `;

        const contents = group.querySelector('.folder-contents');
        group.insertBefore(editor, contents);

        const textarea = editor.querySelector('textarea');
        textarea.focus();

        editor.querySelector('.folder-sysprompt-save').addEventListener('click', () => {
            chatService.updateFolderSystemPrompt(folderId, textarea.value.trim());
            editor.remove();
            toast.success('Folder system prompt saved');
        });

        editor.querySelector('.folder-sysprompt-cancel').addEventListener('click', () => {
            editor.remove();
        });

        // Prevent folder toggle when clicking inside editor
        editor.addEventListener('click', (e) => e.stopPropagation());
    }

    startFolderRename(folderId) {
        const group = document.querySelector(`.folder-group[data-folder-id="${folderId}"]`);
        if (!group) return;
        const nameEl = group.querySelector('.folder-name');
        if (!nameEl) return;

        const folder = chatService.getFolder(folderId);
        const currentName = folder?.name || '';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'chat-title-input';
        input.value = currentName;
        nameEl.replaceWith(input);
        input.focus();
        input.select();

        let committed = false;
        const commit = () => {
            if (committed) return;
            committed = true;
            const newName = input.value.trim();
            if (newName && newName !== currentName) {
                chatService.renameFolder(folderId, newName);
            } else {
                this.refreshChatList();
            }
        };

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { e.preventDefault(); committed = true; this.refreshChatList(); }
        });
        input.addEventListener('blur', commit);
        input.addEventListener('click', (e) => e.stopPropagation());
    }

    showFolderMenu(chatId, anchorEl) {
        // Remove existing menu
        document.querySelectorAll('.folder-menu').forEach(m => m.remove());

        const folders = chatService.getAllFolders();
        const chat = chatService.getChat(chatId);

        const menu = document.createElement('div');
        menu.className = 'folder-menu';

        let items = '';
        if (chat?.folderId) {
            items += `<div class="folder-menu-item" data-folder-id="">
                <i data-lucide="corner-left-up" class="icon"></i> Remove from folder
            </div>`;
        }
        for (const f of folders) {
            const active = chat?.folderId === f.id ? ' active' : '';
            items += `<div class="folder-menu-item${active}" data-folder-id="${f.id}">
                <i data-lucide="folder" class="icon"></i> ${escapeHtml(f.name)}
            </div>`;
        }
        if (folders.length === 0) {
            items += `<div class="folder-menu-empty">No folders yet</div>`;
        }

        menu.innerHTML = items;

        // Position near the button
        const rect = anchorEl.getBoundingClientRect();
        menu.style.position = 'fixed';
        menu.style.left = `${rect.left}px`;
        menu.style.top = `${rect.bottom + 4}px`;
        document.body.appendChild(menu);

        refreshIcons();

        // Click handler
        menu.querySelectorAll('.folder-menu-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const folderId = item.dataset.folderId || null;
                chatService.moveChatToFolder(chatId, folderId);
                menu.remove();
            });
        });

        // Close on outside click
        const close = (e) => {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', close, true);
            }
        };
        setTimeout(() => document.addEventListener('click', close, true), 0);
    }

}

export function createChatSidebar(containerId) {
    return new ChatSidebar(containerId);
}
