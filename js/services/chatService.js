/**
 * ChatService - Manages chat sessions and message history
 * Coordinates between UI, Ollama service, and storage
 */

import { storageService } from './storageService.js?v=34';
import { contextService } from './contextService.js?v=34';
import { providerManager } from './providerManager.js?v=34';
import { eventBus, Events } from '../utils/eventBus.js?v=34';

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
        this.load();
    }

    /**
     * Load chats and folders from storage
     */
    load() {
        this.chats = storageService.loadChats();
        this.folders = storageService.loadFolders();
    }

    /**
     * Save chats to storage
     */
    save() {
        storageService.saveChats(this.chats);
    }

    saveFolders() {
        storageService.saveFolders(this.folders);
    }

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
        this.save();

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
    addMessage(role, content, thinking = '', stats = null, images = null) {
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

        // Persist stats for assistant messages
        if (stats && role === 'assistant') {
            message.stats = stats;
        }

        // Persist images for user messages
        if (images && images.length > 0) {
            message.images = images;
        }

        chat.messages.push(message);
        chat.updatedAt = new Date().toISOString();

        // Update title from first user message
        if (chat.title === 'New Chat' && role === 'user') {
            chat.title = generateTitle(content);
        }

        this.save();
        eventBus.emit(Events.CHAT_UPDATED, { id: this.currentChatId, chat });

        return message;
    }

    /**
     * Add a tool result message to the current chat.
     * @param {string} toolName - Name of the tool (e.g. 'calc')
     * @param {string} input    - Arguments JSON string
     * @param {string} result   - Markdown result string from the tool handler
     * @returns {number} index of the added message
     */
    addToolMessage(toolName, input, result) {
        return this.addToolMessageToChat(this.currentChatId, toolName, input, result);
    }

    /**
     * Add a tool result message to a specific chat (for background streams).
     * @param {string} chatId   - Chat ID
     * @param {string} toolName - Name of the tool
     * @param {string} input    - Arguments JSON string
     * @param {string} result   - Markdown result string
     * @returns {number} index of the added message
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
        this.save();
        eventBus.emit(Events.CHAT_UPDATED, { id: chatId, chat });
        return chat.messages.length - 1;
    }

    /**
     * Update the last assistant message (for streaming)
     * @param {string} content - Updated content
     * @param {string} thinking - Updated thinking content
     */
    updateLastAssistantMessage(content, thinking = '') {
        if (!this.currentChatId) return;

        const chat = this.chats[this.currentChatId];
        const lastMessage = chat.messages[chat.messages.length - 1];

        if (lastMessage && lastMessage.role === 'assistant') {
            lastMessage.content = content;
            lastMessage.thinking = thinking;
            chat.updatedAt = new Date().toISOString();
            this.save();
        }
    }

    /**
     * Get messages formatted for Ollama API, with smart context management
     * @param {number} maxCtx - Maximum context window size
     * @param {string} [systemPrompt] - Optional system prompt to prepend
     * @returns {Promise<{messages: Array<{role: string, content: string}>, summarized: boolean}>}
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
     * Priority: folder prompt > global prompt > empty
     * @returns {string}
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
     * @param {string} chatId
     * @param {string} summary
     * @param {number} summarizedUpTo - message index the summary covers up to
     */
    updateSummary(chatId, summary, summarizedUpTo) {
        if (chatId && this.chats[chatId]) {
            this.chats[chatId].summary = summary;
            this.chats[chatId].summarizedUpTo = summarizedUpTo;
            this.save();
        }
    }

    /**
     * Update chat title
     * @param {string} chatId - Chat ID
     * @param {string} title - New title
     */
    updateChatTitle(chatId, title) {
        if (this.chats[chatId]) {
            this.chats[chatId].title = title;
            this.chats[chatId].updatedAt = new Date().toISOString();
            this.save();
            eventBus.emit(Events.CHAT_UPDATED, { id: chatId, chat: this.chats[chatId] });
        }
    }

    /**
     * Delete the last message from current chat
     * Used for regenerating responses
     */
    deleteLastMessage() {
        const chat = this.getCurrentChat();
        if (chat && chat.messages.length > 0) {
            chat.messages.pop();
            chat.updatedAt = new Date().toISOString();
            this.save();
            eventBus.emit(Events.CHAT_UPDATED, { id: this.currentChatId, chat });
        }
    }

    /**
     * Truncate messages from a given index onwards (inclusive)
     * Used for "regenerate from here" and "edit + resend"
     * @param {number} fromIndex - Index to truncate from
     */
    truncateFromMessage(fromIndex) {
        const chat = this.getCurrentChat();
        if (chat && fromIndex >= 0 && fromIndex < chat.messages.length) {
            chat.messages = chat.messages.slice(0, fromIndex);
            chat.updatedAt = new Date().toISOString();
            this.save();
            eventBus.emit(Events.CHAT_UPDATED, { id: this.currentChatId, chat });
        }
    }

    /**
     * Update message content at a specific index
     * @param {number} index - Message index
     * @param {string} content - New content
     */
    updateMessage(index, content) {
        const chat = this.getCurrentChat();
        if (chat && index >= 0 && index < chat.messages.length) {
            chat.messages[index].content = content;
            chat.updatedAt = new Date().toISOString();
            this.save();
        }
    }

    /**
     * Delete a chat
     * @param {string} chatId - Chat ID to delete
     */
    deleteChat(chatId) {
        if (this.chats[chatId]) {
            delete this.chats[chatId];

            if (this.currentChatId === chatId) {
                // Select another chat or set to null
                const remainingIds = Object.keys(this.chats);
                this.currentChatId = remainingIds.length > 0 ? remainingIds[0] : null;
            }

            this.save();
            eventBus.emit(Events.CHAT_DELETED, { id: chatId });
        }
    }

    /**
     * Get all chats sorted by last updated
     * @returns {Array}
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
        this.save();
        this.saveFolders();
        eventBus.emit(Events.CHAT_DELETED, { id: null, all: true });
    }

    /**
     * Export a specific chat as JSON
     * @param {string} chatId - Chat ID to export
     * @returns {string}
     */
    exportChat(chatId) {
        const chat = this.chats[chatId];
        if (!chat) throw new Error('Chat not found');
        return JSON.stringify({ [chatId]: chat }, null, 2);
    }

    /**
     * Export all chats as JSON
     * @returns {string}
     */
    exportAllChats() {
        return storageService.exportChats();
    }

    /**
     * Import chats from JSON
     * @param {string} jsonString - JSON string of chats
     */
    importChats(jsonString) {
        this.chats = storageService.importChats(jsonString, true);
        eventBus.emit(Events.CHATS_IMPORTED, { chats: this.chats });
    }

    /**
     * Update model for current chat
     * @param {string} model - New model name
     */
    updateModel(model) {
        if (this.currentChatId && this.chats[this.currentChatId]) {
            this.chats[this.currentChatId].model = model;
            this.save();
        }
    }
    /**
     * Update last token count for current chat
     * @param {number} tokenCount - Actual token count from Ollama
     */
    updateTokenCount(tokenCount) {
        this.updateTokenCountForChat(this.currentChatId, tokenCount);
    }

    /**
     * Update last token count for a specific chat
     * @param {string} chatId - Chat ID
     * @param {number} tokenCount - Actual token count
     */
    updateTokenCountForChat(chatId, tokenCount) {
        if (chatId && this.chats[chatId]) {
            this.chats[chatId].lastTokenCount = tokenCount;
            this.save();
        }
    }

    /**
     * Save context meter data for current chat
     * @param {number} used - Tokens used
     * @param {number} max - Max context tokens
     */
    updateContextData(used, max) {
        this.updateContextDataForChat(this.currentChatId, used, max);
    }

    /**
     * Save context meter data for a specific chat
     * @param {string} chatId - Chat ID
     * @param {number} used - Tokens used
     * @param {number} max - Max context tokens
     */
    updateContextDataForChat(chatId, used, max) {
        if (chatId && this.chats[chatId]) {
            this.chats[chatId].contextData = { used, max };
            this.save();
        }
    }

    /**
     * Add a message to a specific chat (for background streams)
     * @param {string} chatId - Chat ID to add message to
     * @param {string} role - 'user' or 'assistant'
     * @param {string} content - Message content
     * @param {string} thinking - Optional thinking content
     * @param {Object} stats - Optional message stats
     * @param {Array<string>} images - Optional array of base64 data URL images
     * @returns {Object} The added message
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

        this.save();
        eventBus.emit(Events.CHAT_UPDATED, { id: chatId, chat });

        return message;
    }

    /**
     * Get a chat by ID
     * @param {string} chatId - Chat ID
     * @returns {Object|null}
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
        // Unassign all chats in this folder
        for (const chat of Object.values(this.chats)) {
            if (chat.folderId === folderId) {
                delete chat.folderId;
            }
        }
        delete this.folders[folderId];
        this.save();
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
        this.save();
        eventBus.emit(Events.CHAT_UPDATED);
    }
}

// Export singleton instance
export const chatService = new ChatService();
