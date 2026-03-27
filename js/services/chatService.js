/**
 * ChatService - Manages chat sessions and message history
 * Coordinates between UI, storage (IndexedDB), and providers
 */

import { storageService } from './storageService.js?v=36';
import { contextService } from './contextService.js?v=36';
import { providerManager } from './providerManager.js?v=36';
import { eventBus, Events } from '../utils/eventBus.js?v=36';

/**
 * Generate unique ID for chats
 * @returns {string}
 */
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

/**
 * Generate chat title from first message
 * @param {string} content - First message content
 * @returns {string}
 */
function generateTitle(content) {
    const maxLength = 40;
    const cleaned = content.trim().replace(/\n/g, ' ');
    return cleaned.length > maxLength
        ? cleaned.substring(0, maxLength) + '...'
        : cleaned;
}

class ChatService {
    constructor() {
        this.chats = {};
        this.folders = {};
        this.currentChatId = null;
        // Do NOT call load() here — app.js will call it after storageService.init()
    }

    /**
     * Load chats and folders from IndexedDB.
     * Must be called once after storageService.init().
     */
    async load() {
        const chatMetas = await storageService.loadAllChats();

        // Attach messages to each chat (in memory)
        for (const chatId of Object.keys(chatMetas)) {
            const messages = await storageService.loadMessagesForChat(chatId);
            // Hydrate images for the messages (lazy per-chat would be better
            // for large datasets, but for now hydrate all on load)
            await storageService.hydrateAttachments(messages);
            chatMetas[chatId].messages = messages;
        }

        this.chats = chatMetas;
        this.folders = storageService.loadFolders();
    }

    // ─── Internal persistence helpers ────────────────────────────────────────

    /**
     * Persist chat metadata (without messages) to IDB.
     * Uses write coalescing for rapid successive calls.
     * @private
     */
    _persistChat(chat) {
        // Build a metadata-only copy (no messages array)
        const meta = { ...chat };
        delete meta.messages;
        storageService.saveChat(meta);
    }

    /**
     * Persist a single message to IDB.
     * @private
     */
    _persistMessage(chatId, message) {
        // Extract images to attachment store if present
        if (message.images && message.images.length > 0) {
            // Build a persistence copy without images (attachmentIds instead)
            const persistMsg = { ...message };
            storageService.extractAttachments(chatId, persistMsg).then(() => {
                // Save the message with attachmentIds (not images)
                const { images, ...msgForIdb } = persistMsg;
                storageService.saveMessage(chatId, msgForIdb);
            }).catch(e => console.error('Failed to persist message attachments:', e));
        } else {
            storageService.saveMessage(chatId, message).catch(
                e => console.error('Failed to persist message:', e)
            );
        }
    }

    saveFolders() {
        storageService.saveFolders(this.folders);
    }

    // ─── Chat CRUD ───────────────────────────────────────────────────────────

    /**
     * Create a new chat session
     * @param {string} model - Model name to use
     * @returns {string} New chat ID
     */
    createChat(model) {
        const id = generateId();

        this.chats[id] = {
            id,
            title: 'New Chat',
            model,
            provider: providerManager.getProviderName(),
            messages: [],
            summary: null,
            summarizedUpTo: 0,
            lastTokenCount: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        this.currentChatId = id;
        this._persistChat(this.chats[id]);

        eventBus.emit(Events.CHAT_CREATED, { id, chat: this.chats[id] });

        return id;
    }

    /**
     * Get current chat
     * @returns {Object|null}
     */
    getCurrentChat() {
        return this.currentChatId ? this.chats[this.currentChatId] : null;
    }

    /**
     * Get current chat ID
     * @returns {string|null}
     */
    getCurrentChatId() {
        return this.currentChatId;
    }

    /**
     * Select/switch to a chat
     * @param {string} chatId - Chat ID to select
     */
    selectChat(chatId) {
        if (this.chats[chatId]) {
            this.currentChatId = chatId;
            eventBus.emit(Events.CHAT_SELECTED, {
                id: chatId,
                chat: this.chats[chatId]
            });
        }
    }

    /**
     * Add a message to current chat
     * @param {string} role - 'user' or 'assistant'
     * @param {string} content - Message content
     * @param {string} thinking - Optional thinking content
     * @param {Object} stats - Optional message stats (tok/s, tokens, etc.)
     * @param {Array<string>} images - Optional array of base64 data URL images
     * @returns {Object} The added message
     */
    addMessage(role, content, thinking = '', stats = null, images = null, documents = null) {
        if (!this.currentChatId) {
            throw new Error('No active chat');
        }

        const chat = this.chats[this.currentChatId];
        const message = {
            id: generateId(),
            role,
            content,
            thinking,
            timestamp: new Date().toISOString()
        };

        if (stats && role === 'assistant') {
            message.stats = stats;
        }

        if (images && images.length > 0) {
            message.images = images;
        }

        if (documents && documents.length > 0) {
            message.documents = documents;
        }

        chat.messages.push(message);
        chat.updatedAt = new Date().toISOString();

        if (chat.title === 'New Chat' && role === 'user') {
            chat.title = generateTitle(content);
        }

        this._persistMessage(this.currentChatId, message);
        this._persistChat(chat);
        eventBus.emit(Events.CHAT_UPDATED, { id: this.currentChatId, chat });

        return message;
    }

    /**
     * Add a tool result message to the current chat.
     */
    addToolMessage(toolName, input, result) {
        return this.addToolMessageToChat(this.currentChatId, toolName, input, result);
    }

    /**
     * Add a tool result message to a specific chat (for background streams).
     */
    addToolMessageToChat(chatId, toolName, input, result) {
        if (!chatId || !this.chats[chatId]) throw new Error('No active chat');
        const chat = this.chats[chatId];
        const message = {
            id: generateId(),
            role: 'tool',
            toolName,
            input,
            content: result,
            timestamp: new Date().toISOString(),
        };
        chat.messages.push(message);
        chat.updatedAt = new Date().toISOString();

        this._persistMessage(chatId, message);
        this._persistChat(chat);
        eventBus.emit(Events.CHAT_UPDATED, { id: chatId, chat });
        return chat.messages.length - 1;
    }

    /**
     * Update the last assistant message (for streaming)
     */
    updateLastAssistantMessage(content, thinking = '') {
        if (!this.currentChatId) return;

        const chat = this.chats[this.currentChatId];
        const lastMessage = chat.messages[chat.messages.length - 1];

        if (lastMessage && lastMessage.role === 'assistant') {
            lastMessage.content = content;
            lastMessage.thinking = thinking;
            chat.updatedAt = new Date().toISOString();
            this._persistMessage(this.currentChatId, lastMessage);
            this._persistChat(chat);
        }
    }

    /**
     * Get messages formatted for API, with smart context management
     */
    async getMessagesForApi(maxCtx = 4096, systemPrompt = '') {
        const chat = this.getCurrentChat();
        if (!chat) return { messages: [], summarized: false };

        const result = await contextService.prepareMessages(chat, maxCtx, systemPrompt);

        return {
            messages: result.messages,
            summarized: result.summarized
        };
    }

    /**
     * Resolve the system prompt for the current chat.
     */
    getSystemPrompt() {
        const chat = this.getCurrentChat();
        if (chat?.folderId) {
            const folder = this.getFolder(chat.folderId);
            if (folder?.systemPrompt) return folder.systemPrompt;
        }
        const settings = storageService.loadSettings();
        return settings.systemPrompt || '';
    }

    /**
     * Store a background-generated summary on a chat
     */
    updateSummary(chatId, summary, summarizedUpTo) {
        if (chatId && this.chats[chatId]) {
            this.chats[chatId].summary = summary;
            this.chats[chatId].summarizedUpTo = summarizedUpTo;
            this._persistChat(this.chats[chatId]);
        }
    }

    /**
     * Update chat title
     */
    updateChatTitle(chatId, title) {
        if (this.chats[chatId]) {
            this.chats[chatId].title = title;
            this.chats[chatId].updatedAt = new Date().toISOString();
            this._persistChat(this.chats[chatId]);
            eventBus.emit(Events.CHAT_UPDATED, { id: chatId, chat: this.chats[chatId] });
        }
    }

    /**
     * Delete the last message from current chat
     */
    deleteLastMessage() {
        const chat = this.getCurrentChat();
        if (chat && chat.messages.length > 0) {
            const removed = chat.messages.pop();
            chat.updatedAt = new Date().toISOString();
            // Delete from IDB
            if (removed?.id) {
                storageService.deleteMessagesForChat(this.currentChatId).then(() =>
                    storageService.saveMessages(this.currentChatId, chat.messages)
                ).catch(e => console.error('Failed to delete message:', e));
            }
            this._persistChat(chat);
            eventBus.emit(Events.CHAT_UPDATED, { id: this.currentChatId, chat });
        }
    }

    /**
     * Truncate messages from a given index onwards (inclusive)
     */
    truncateFromMessage(fromIndex) {
        const chat = this.getCurrentChat();
        if (chat && fromIndex >= 0 && fromIndex < chat.messages.length) {
            chat.messages = chat.messages.slice(0, fromIndex);
            chat.updatedAt = new Date().toISOString();
            // Rewrite all messages for this chat in IDB
            storageService.deleteMessagesForChat(this.currentChatId).then(() =>
                storageService.saveMessages(this.currentChatId, chat.messages)
            ).catch(e => console.error('Failed to truncate messages:', e));
            this._persistChat(chat);
            eventBus.emit(Events.CHAT_UPDATED, { id: this.currentChatId, chat });
        }
    }

    /**
     * Update message content at a specific index
     */
    updateMessage(index, content) {
        const chat = this.getCurrentChat();
        if (chat && index >= 0 && index < chat.messages.length) {
            chat.messages[index].content = content;
            chat.updatedAt = new Date().toISOString();
            this._persistMessage(this.currentChatId, chat.messages[index]);
            this._persistChat(chat);
        }
    }

    /**
     * Delete a chat
     */
    deleteChat(chatId) {
        if (this.chats[chatId]) {
            delete this.chats[chatId];

            if (this.currentChatId === chatId) {
                const remainingIds = Object.keys(this.chats);
                this.currentChatId = remainingIds.length > 0 ? remainingIds[0] : null;
            }

            storageService.deleteChat(chatId).catch(
                e => console.error('Failed to delete chat:', e)
            );
            eventBus.emit(Events.CHAT_DELETED, { id: chatId });
        }
    }

    /**
     * Get all chats sorted by last updated
     */
    getAllChats() {
        return Object.values(this.chats).sort(
            (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)
        );
    }

    /**
     * Delete all chats
     */
    deleteAllChats() {
        this.chats = {};
        this.folders = {};
        this.currentChatId = null;
        storageService.clearChats().catch(
            e => console.error('Failed to clear chats:', e)
        );
        eventBus.emit(Events.CHAT_DELETED, { id: null, all: true });
    }

    /**
     * Export a specific chat as JSON
     */
    exportChat(chatId) {
        const chat = this.chats[chatId];
        if (!chat) throw new Error('Chat not found');
        return JSON.stringify({ [chatId]: chat }, null, 2);
    }

    /**
     * Export all chats as JSON
     */
    exportAllChats() {
        return storageService.exportChats();
    }

    /**
     * Import chats from JSON
     */
    async importChats(jsonString) {
        this.chats = await storageService.importChats(jsonString, true);
        eventBus.emit(Events.CHATS_IMPORTED, { chats: this.chats });
    }

    /**
     * Update model for current chat
     */
    updateModel(model) {
        if (this.currentChatId && this.chats[this.currentChatId]) {
            this.chats[this.currentChatId].model = model;
            this._persistChat(this.chats[this.currentChatId]);
        }
    }

    /**
     * Update last token count for current chat
     */
    updateTokenCount(tokenCount) {
        this.updateTokenCountForChat(this.currentChatId, tokenCount);
    }

    /**
     * Update last token count for a specific chat
     */
    updateTokenCountForChat(chatId, tokenCount) {
        if (chatId && this.chats[chatId]) {
            this.chats[chatId].lastTokenCount = tokenCount;
            this._persistChat(this.chats[chatId]);
        }
    }

    /**
     * Save context meter data for current chat
     */
    updateContextData(used, max) {
        this.updateContextDataForChat(this.currentChatId, used, max);
    }

    /**
     * Save context meter data for a specific chat
     */
    updateContextDataForChat(chatId, used, max) {
        if (chatId && this.chats[chatId]) {
            this.chats[chatId].contextData = { used, max };
            this._persistChat(this.chats[chatId]);
        }
    }

    /**
     * Add a message to a specific chat (for background streams)
     */
    addMessageToChat(chatId, role, content, thinking = '', stats = null, images = null) {
        if (!chatId || !this.chats[chatId]) {
            throw new Error('Chat not found: ' + chatId);
        }

        const chat = this.chats[chatId];
        const message = {
            id: generateId(),
            role,
            content,
            thinking,
            timestamp: new Date().toISOString()
        };

        if (stats && role === 'assistant') {
            message.stats = stats;
        }

        if (images && images.length > 0) {
            message.images = images;
        }

        chat.messages.push(message);
        chat.updatedAt = new Date().toISOString();

        if (chat.title === 'New Chat' && role === 'user') {
            chat.title = generateTitle(content);
        }

        this._persistMessage(chatId, message);
        this._persistChat(chat);
        eventBus.emit(Events.CHAT_UPDATED, { id: chatId, chat });

        return message;
    }

    /**
     * Get a chat by ID
     */
    getChat(chatId) {
        return this.chats[chatId] || null;
    }

    // ── Folder management ──

    getAllFolders() {
        return Object.values(this.folders).sort(
            (a, b) => a.name.localeCompare(b.name)
        );
    }

    getFolder(folderId) {
        return this.folders[folderId] || null;
    }

    createFolder(name) {
        const id = generateId();
        this.folders[id] = {
            id,
            name,
            collapsed: false,
            systemPrompt: '',
            createdAt: new Date().toISOString()
        };
        this.saveFolders();
        eventBus.emit(Events.CHAT_UPDATED);
        return id;
    }

    renameFolder(folderId, name) {
        if (this.folders[folderId]) {
            this.folders[folderId].name = name;
            this.saveFolders();
            eventBus.emit(Events.CHAT_UPDATED);
        }
    }

    deleteFolder(folderId) {
        if (!this.folders[folderId]) return;
        for (const chat of Object.values(this.chats)) {
            if (chat.folderId === folderId) {
                delete chat.folderId;
                this._persistChat(chat);
            }
        }
        delete this.folders[folderId];
        this.saveFolders();
        eventBus.emit(Events.CHAT_UPDATED);
    }

    updateFolderSystemPrompt(folderId, prompt) {
        if (this.folders[folderId]) {
            this.folders[folderId].systemPrompt = prompt;
            this.saveFolders();
        }
    }

    toggleFolderCollapsed(folderId) {
        if (this.folders[folderId]) {
            this.folders[folderId].collapsed = !this.folders[folderId].collapsed;
            this.saveFolders();
        }
    }

    moveChatToFolder(chatId, folderId) {
        if (!this.chats[chatId]) return;
        if (folderId && !this.folders[folderId]) return;
        if (folderId) {
            this.chats[chatId].folderId = folderId;
        } else {
            delete this.chats[chatId].folderId;
        }
        this._persistChat(this.chats[chatId]);
        eventBus.emit(Events.CHAT_UPDATED);
    }
}

// Export singleton instance
export const chatService = new ChatService();
