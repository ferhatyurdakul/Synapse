/**
 * ChatSidebar - Sidebar component for chat management
 * Handles chat list, new chat, import/export
 */

import { chatService } from '../services/chatService.js?v=18';
import { eventBus, Events } from '../utils/eventBus.js?v=18';
import { openSettings } from './settingsPanel.js?v=18';

class ChatSidebar {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.selectedModel = null;

        this.init();
    }

    init() {
        this.render();
        this.attachEvents();
        this.listenToEvents();
        this.refreshChatList();
    }

    render() {
        this.container.innerHTML = `
            <div class="sidebar">
                <div class="sidebar-header">
                    <h1 class="app-title">
                        <span class="title-icon">⟩</span> Synapse
                    </h1>
                </div>
                
                <div class="sidebar-actions">
                    <button id="new-chat-btn" class="action-btn primary">
                        <span>+</span> New Chat
                    </button>
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
                        ⚙️ Settings
                    </button>
                    <button id="delete-all-btn" class="footer-btn danger" title="Delete all chats">
                        🗑 Delete All
                    </button>
                    <div class="footer-row">
                        <button id="import-btn" class="footer-btn" title="Import chats">
                            ↓ Import
                        </button>
                        <button id="export-btn" class="footer-btn" title="Export current chat" disabled>
                            ↑ Export
                        </button>
                    </div>
                </div>
                
                <input type="file" id="import-input" accept=".json" style="display: none;">
            </div>
        `;
    }

    attachEvents() {
        // New chat button
        document.getElementById('new-chat-btn').addEventListener('click', () => {
            this.createNewChat();
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
            this.handleExport();
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
        if (!this.selectedModel) {
            console.warn('No model selected');
            return;
        }

        chatService.createChat(this.selectedModel);
    }

    refreshChatList() {
        const listEl = document.getElementById('chat-list');
        const chats = chatService.getAllChats();
        const currentId = chatService.getCurrentChatId();

        if (chats.length === 0) {
            listEl.innerHTML = `
                <div class="empty-state">
                    No chats yet.<br>
                    Click "New Chat" to start.
                </div>
            `;
            return;
        }

        listEl.innerHTML = chats.map(chat => `
            <div class="chat-item ${chat.id === currentId ? 'active' : ''}" data-id="${chat.id}">
                <div class="chat-item-content">
                    <span class="chat-icon">💬</span>
                    <span class="chat-title">${this.escapeHtml(chat.title)}</span>
                </div>
                <button class="delete-chat-btn" data-id="${chat.id}" title="Delete chat">×</button>
            </div>
        `).join('');

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

    handleExport() {
        const currentChat = chatService.getCurrentChat();
        if (!currentChat || currentChat.messages.length === 0) {
            return;
        }

        const json = chatService.exportChat(currentChat.id);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        const title = currentChat.title.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
        a.download = `chat-${title}-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
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
