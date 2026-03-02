/**
 * ChatService - Manages chat sessions and message history
 * Coordinates between UI, Ollama service, and storage
 */

import { storageService } from './storageService.js?v=26';
import { contextService } from './contextService.js?v=26';
import { eventBus, Events } from '../utils/eventBus.js?v=26';

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
        this.currentChatId = null;
        this.load();
    }

    /**
     * Load chats from storage
     */
    load() {
        this.chats = storageService.loadChats();
    }

    /**
     * Save chats to storage
     */
    save() {
        storageService.saveChats(this.chats);
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
     * @returns {Object} The added message
     */
    addMessage(role, content, thinking = '') {
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
     * @returns {Promise<{messages: Array<{role: string, content: string}>, summarized: boolean}>}
     */
    async getMessagesForApi(maxCtx = 4096) {
        const chat = this.getCurrentChat();
        if (!chat) return { messages: [], summarized: false };

        const result = await contextService.prepareMessages(chat, maxCtx);

        // Store summary if generated
        if (result.summary && result.summarizedUpTo > (chat.summarizedUpTo || 0)) {
            chat.summary = result.summary;
            chat.summarizedUpTo = result.summarizedUpTo;
            this.save();
        }

        return {
            messages: result.messages,
            summarized: result.summarized
        };
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
        this.currentChatId = null;
        this.save();
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
        if (this.currentChatId && this.chats[this.currentChatId]) {
            this.chats[this.currentChatId].lastTokenCount = tokenCount;
            this.save();
        }
    }
}

// Export singleton instance
export const chatService = new ChatService();
