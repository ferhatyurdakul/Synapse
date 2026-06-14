/**
 * ChatService - Manages chat sessions and message history
 * Coordinates between UI, storage (IndexedDB), and providers
 */

import { storageService } from './storageService.js';
import { contextService } from './contextService.js';
import { providerManager } from './providerManager.js';
import { skillService } from './skillService.js';
import { eventBus, Events } from '../utils/eventBus.js';
import { getSessionModeConfig, normalizeSessionMode } from '../config/sessionModes.js';

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

function normalizeSeedMessages(messages = []) {
    return messages
        .filter(msg => msg && (msg.role === 'user' || msg.role === 'assistant') && msg.content)
        .map(msg => ({
            id: generateId(),
            role: msg.role,
            content: String(msg.content),
            thinking: msg.role === 'assistant' ? String(msg.thinking || '') : '',
            timestamp: msg.timestamp || new Date().toISOString()
        }));
}

function cloneChatMessage(message, idFactory) {
    const clone = { ...message, id: idFactory() };
    if (clone.images) clone.images = [...clone.images];
    if (clone.documents) clone.documents = [...clone.documents];
    if (clone.attachmentIds) clone.attachmentIds = [...clone.attachmentIds];
    return clone;
}

class ChatService {
    constructor() {
        this.chats = {};
        this.folders = {};
        this.currentChatId = null;
        this.currentMode = 'chat';
        this.pendingFolderId = null;
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
            if (this._normalizeChatMeta(chatMetas[chatId])) {
                this._persistChat(chatMetas[chatId]);
            }
        }

        this.chats = chatMetas;
        this.folders = storageService.loadFolders();
    }

    _normalizeChatMeta(chat) {
        const normalizedMode = normalizeSessionMode(chat.mode);
        if (chat.mode !== normalizedMode) {
            chat.mode = normalizedMode;
            return true;
        }
        return false;
    }

    _setCurrentMode(mode, emit = true) {
        const normalizedMode = normalizeSessionMode(mode);
        if (this.currentMode === normalizedMode) return false;
        this.currentMode = normalizedMode;
        if (emit) {
            eventBus.emit(Events.SESSION_MODE_CHANGED, { mode: normalizedMode });
        }
        return true;
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
    createChat(modelOrOptions) {
        const options = typeof modelOrOptions === 'object' && modelOrOptions !== null
            ? modelOrOptions
            : { model: modelOrOptions };
        const id = generateId();
        const now = new Date().toISOString();
        const seedMessages = normalizeSeedMessages(options.messages);

        this.chats[id] = {
            id,
            title: options.title || 'New Chat',
            mode: normalizeSessionMode(options.mode || this.currentMode),
            model: options.model || null,
            provider: options.provider || providerManager.getProviderName(),
            messages: seedMessages,
            summary: null,
            summarizedUpTo: 0,
            lastTokenCount: 0,
            parentChatId: null,
            forkedFromMessageId: null,
            systemPrompt: options.systemPrompt ?? null,
            templateId: options.templateId || null,
            activeSkillIds: Array.isArray(options.activeSkillIds) ? options.activeSkillIds : [],
            skillInjectionLog: [],
            createdAt: now,
            updatedAt: now
        };

        this.currentChatId = id;
        this._setCurrentMode(this.chats[id].mode);
        this._persistChat(this.chats[id]);
        if (seedMessages.length > 0) {
            storageService.saveMessages(id, seedMessages).catch(
                e => console.error('Failed to save seed messages:', e)
            );
        }

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

    getCurrentMode() {
        return this.currentMode;
    }

    /**
     * Select/switch to a chat
     * @param {string} chatId - Chat ID to select
     */
    selectChat(chatId, options = {}) {
        if (this.chats[chatId]) {
            this.currentChatId = chatId;
            if (options.syncMode !== false) {
                this._setCurrentMode(this.chats[chatId].mode);
            }
            eventBus.emit(Events.CHAT_SELECTED, {
                id: chatId,
                chat: this.chats[chatId]
            });
        }
    }

    /**
     * Deselect current chat (show welcome/new chat screen)
     */
    deselectChat() {
        this.currentChatId = null;
        eventBus.emit(Events.CHAT_SELECTED, { id: null, chat: null });
    }

    setCurrentMode(mode) {
        const normalizedMode = normalizeSessionMode(mode);
        this._setCurrentMode(normalizedMode);

        const currentChat = this.getCurrentChat();
        if (currentChat?.mode === normalizedMode) return;

        const nextChat = this.getChatsForMode(normalizedMode)[0];
        if (nextChat) {
            this.selectChat(nextChat.id, { syncMode: false });
            return;
        }

        this.deselectChat();
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
        let basePrompt = '';
        if (chat && Object.prototype.hasOwnProperty.call(chat, 'systemPrompt') && chat.systemPrompt !== null) {
            basePrompt = chat.systemPrompt || '';
        } else if (chat?.folderId) {
            const folder = this.getFolder(chat.folderId);
            basePrompt = folder?.systemPrompt || '';
        } else {
            const settings = storageService.loadSettings();
            basePrompt = settings.systemPrompt || '';
        }
        return skillService.buildSystemPrompt(basePrompt, chat?.activeSkillIds || []);
    }

    getActiveSkillSummaries(chatId = this.currentChatId) {
        return skillService.getInjectionSummary(this.getChat(chatId));
    }

    updateSkills(chatId, skillIds = []) {
        if (!chatId || !this.chats[chatId]) return;
        const activeSkillIds = [...new Set(skillIds)].filter(Boolean);
        this.chats[chatId].activeSkillIds = activeSkillIds;
        this.chats[chatId].skillInjectionLog = skillService.getInjectionSummary(this.chats[chatId]);
        this.chats[chatId].updatedAt = new Date().toISOString();
        this._persistChat(this.chats[chatId]);
        eventBus.emit(Events.CHAT_UPDATED, { id: chatId, chat: this.chats[chatId] });
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
            // Orphan any branches so they become standalone root chats
            for (const branch of this.getBranchesOf(chatId)) {
                branch.parentChatId = null;
                branch.forkedFromMessageId = null;
                this._persistChat(branch);
            }

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

    getChatsForMode(mode = this.currentMode) {
        const normalizedMode = normalizeSessionMode(mode);
        return this.getAllChats().filter(chat => normalizeSessionMode(chat.mode) === normalizedMode);
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
     * Get all branches (child chats) of a given chat.
     * @param {string} chatId
     * @returns {Object[]} Branch chats sorted by createdAt
     */
    getBranchesOf(chatId) {
        return Object.values(this.chats)
            .filter(c => c.parentChatId === chatId)
            .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    }

    /**
     * Fork a chat from a specific message, creating a new branch.
     * Copies messages up to and including the fork point message.
     * @param {string} sourceChatId - Chat to fork from
     * @param {string} fromMessageId - Message ID at the fork point
     * @param {Object} [options] - { silent: boolean } - if silent, don't switch to the new chat
     * @returns {Promise<string>} New branch chat ID
     */
    async forkChat(sourceChatId, fromMessageId, options) {
        const source = this.chats[sourceChatId];
        if (!source) throw new Error('Source chat not found');

        const msgIndex = source.messages.findIndex(m => m.id === fromMessageId);
        if (msgIndex < 0) throw new Error('Fork-point message not found');

        const id = generateId();
        const now = new Date().toISOString();

        // Deep-clone messages up to the fork point with new IDs
        const oldToNewMsgId = new Map();
        const clonedMessages = source.messages.slice(0, msgIndex + 1).map(msg => {
            const newMsgId = generateId();
            oldToNewMsgId.set(msg.id, newMsgId);
            const clone = { ...msg, id: newMsgId };
            // Clone arrays so they're independent
            if (clone.images) clone.images = [...clone.images];
            if (clone.documents) clone.documents = [...clone.documents];
            if (clone.attachmentIds) clone.attachmentIds = [...clone.attachmentIds];
            return clone;
        });

        // Build the title
        const titleBase = source.title || 'New Chat';
        const branchTitle = `Branch: ${titleBase}`.slice(0, 60);

        this.chats[id] = {
            id,
            title: branchTitle,
            mode: normalizeSessionMode(source.mode),
            model: source.model,
            provider: source.provider,
            messages: clonedMessages,
            summary: null,
            summarizedUpTo: 0,
            lastTokenCount: 0,
            parentChatId: sourceChatId,
            forkedFromMessageId: fromMessageId,
            folderId: source.folderId || undefined,
            createdAt: now,
            updatedAt: now
        };

        // Persist chat metadata
        this._persistChat(this.chats[id]);

        // Persist messages
        for (const msg of clonedMessages) {
            storageService.saveMessage(id, msg);
        }

        // Duplicate image attachments from source chat
        try {
            const sourceAttachments = await storageService.getAttachmentsForChat(sourceChatId);
            for (const att of sourceAttachments) {
                const newMsgId = oldToNewMsgId.get(att.messageId);
                if (!newMsgId) continue; // attachment belongs to a message after the fork point
                const newAttId = storageService._generateId();
                await storageService.saveAttachment(newAttId, id, newMsgId, att.blob, att.mimeType);

                // Update the cloned message's attachmentIds
                const clonedMsg = clonedMessages.find(m => m.id === newMsgId);
                if (clonedMsg?.attachmentIds) {
                    const oldIdx = clonedMsg.attachmentIds.indexOf(att.id);
                    if (oldIdx >= 0) clonedMsg.attachmentIds[oldIdx] = newAttId;
                }
            }
        } catch (e) {
            console.warn('Failed to duplicate attachments for branch:', e);
        }

        eventBus.emit(Events.CHAT_FORKED, { id, parentChatId: sourceChatId, forkedFromMessageId: fromMessageId });
        eventBus.emit(Events.CHAT_CREATED, { id, chat: this.chats[id] });

        // Select the new branch unless caller opts out
        if (!options?.silent) {
            this.currentChatId = id;
        }

        return id;
    }

    /**
     * Branch an entire session into a new workspace mode without changing the source.
     * @param {string} sourceChatId - Chat to branch from
     * @param {string} targetMode - Mode for the new branched session
     * @returns {Promise<string>} New branch chat ID
     */
    async branchChatToMode(sourceChatId, targetMode) {
        const source = this.chats[sourceChatId];
        if (!source) throw new Error('Source chat not found');

        const normalizedMode = normalizeSessionMode(targetMode);
        const id = generateId();
        const now = new Date().toISOString();
        const oldToNewMsgId = new Map();
        const clonedMessages = source.messages.map(msg => {
            const clone = cloneChatMessage(msg, generateId);
            oldToNewMsgId.set(msg.id, clone.id);
            return clone;
        });

        const targetConfig = getSessionModeConfig(normalizedMode);
        const titleBase = source.title || 'New Chat';
        const branchTitle = `${targetConfig.shortLabel}: ${titleBase}`.slice(0, 60);
        const forkedFromMessageId = source.messages[source.messages.length - 1]?.id || null;

        this.chats[id] = {
            ...source,
            id,
            title: branchTitle,
            mode: normalizedMode,
            messages: clonedMessages,
            summary: null,
            summarizedUpTo: 0,
            lastTokenCount: source.lastTokenCount || 0,
            parentChatId: sourceChatId,
            forkedFromMessageId,
            createdAt: now,
            updatedAt: now
        };

        this._persistChat(this.chats[id]);

        for (const msg of clonedMessages) {
            storageService.saveMessage(id, msg);
        }

        try {
            const sourceAttachments = await storageService.getAttachmentsForChat(sourceChatId);
            for (const att of sourceAttachments) {
                const newMsgId = oldToNewMsgId.get(att.messageId);
                if (!newMsgId) continue;
                const newAttId = storageService._generateId();
                await storageService.saveAttachment(newAttId, id, newMsgId, att.blob, att.mimeType);

                const clonedMsg = clonedMessages.find(message => message.id === newMsgId);
                if (clonedMsg?.attachmentIds) {
                    const oldIdx = clonedMsg.attachmentIds.indexOf(att.id);
                    if (oldIdx >= 0) clonedMsg.attachmentIds[oldIdx] = newAttId;
                }
            }
        } catch (e) {
            console.warn('Failed to duplicate attachments for mode branch:', e);
        }

        this.currentChatId = id;
        this._setCurrentMode(normalizedMode);
        eventBus.emit(Events.CHAT_FORKED, { id, parentChatId: sourceChatId, forkedFromMessageId });
        eventBus.emit(Events.CHAT_CREATED, { id, chat: this.chats[id] });

        return id;
    }

    /**
     * Convert an existing session into another workspace mode in place.
     * @param {string} chatId - Chat to convert
     * @param {string} targetMode - Mode to assign
     */
    convertChatToMode(chatId, targetMode) {
        const chat = this.chats[chatId];
        if (!chat) throw new Error('Chat not found');

        const normalizedMode = normalizeSessionMode(targetMode);
        if (chat.mode === normalizedMode) return;

        chat.mode = normalizedMode;
        chat.updatedAt = new Date().toISOString();
        this._persistChat(chat);

        if (this.currentChatId === chatId) {
            this._setCurrentMode(normalizedMode);
            eventBus.emit(Events.CHAT_SELECTED, { id: chatId, chat });
            return;
        }

        eventBus.emit(Events.CHAT_UPDATED, { id: chatId, chat });
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
        Object.values(this.chats).forEach(chat => {
            if (this._normalizeChatMeta(chat)) {
                this._persistChat(chat);
            }
        });
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

    updateSystemPrompt(chatId, prompt) {
        if (!chatId || !this.chats[chatId]) return;
        this.chats[chatId].systemPrompt = prompt ?? '';
        this._persistChat(this.chats[chatId]);
        eventBus.emit(Events.CHAT_UPDATED, { id: chatId, chat: this.chats[chatId] });
    }

    // ── Mode transitions ──

    /**
     * Branch a session to a different mode.
     * Creates a new chat with the full message history in the target mode,
     * linked to the source via parentChatId.
     * @param {string} sourceChatId - Chat to branch from
     * @param {string} targetMode - Target mode for the new chat
     * @returns {Promise<string>} New branch chat ID
     */
    async branchToMode(sourceChatId, targetMode) {
        const source = this.chats[sourceChatId];
        if (!source) throw new Error('Source chat not found');

        const id = generateId();
        const now = new Date().toISOString();
        const normalizedTarget = normalizeSessionMode(targetMode);

        // Deep-clone all messages with new IDs
        const oldToNewMsgId = new Map();
        const clonedMessages = source.messages.map(msg => {
            const newMsgId = generateId();
            oldToNewMsgId.set(msg.id, newMsgId);
            const clone = { ...msg, id: newMsgId };
            if (clone.images) clone.images = [...clone.images];
            if (clone.documents) clone.documents = [...clone.documents];
            if (clone.attachmentIds) clone.attachmentIds = [...clone.attachmentIds];
            return clone;
        });

        this.chats[id] = {
            id,
            title: source.title || 'New Chat',
            mode: normalizedTarget,
            model: source.model,
            provider: source.provider,
            messages: clonedMessages,
            summary: null,
            summarizedUpTo: 0,
            lastTokenCount: 0,
            parentChatId: sourceChatId,
            forkedFromMessageId: source.messages.length > 0
                ? source.messages[source.messages.length - 1].id
                : null,
            folderId: source.folderId || undefined,
            createdAt: now,
            updatedAt: now
        };

        this._persistChat(this.chats[id]);
        for (const msg of clonedMessages) {
            storageService.saveMessage(id, msg);
        }

        // Duplicate image attachments from source
        try {
            const sourceAttachments = await storageService.getAttachmentsForChat(sourceChatId);
            for (const att of sourceAttachments) {
                const newMsgId = oldToNewMsgId.get(att.messageId);
                if (!newMsgId) continue;
                const newAttId = storageService._generateId();
                await storageService.saveAttachment(newAttId, id, newMsgId, att.blob, att.mimeType);
                const clonedMsg = clonedMessages.find(m => m.id === newMsgId);
                if (clonedMsg?.attachmentIds) {
                    const oldIdx = clonedMsg.attachmentIds.indexOf(att.id);
                    if (oldIdx >= 0) clonedMsg.attachmentIds[oldIdx] = newAttId;
                }
            }
        } catch (e) {
            console.warn('Failed to duplicate attachments for mode branch:', e);
        }

        eventBus.emit(Events.CHAT_FORKED, { id, parentChatId: sourceChatId });
        eventBus.emit(Events.CHAT_CREATED, { id, chat: this.chats[id] });

        return id;
    }

    /**
     * Convert a session's mode in place.
     * @param {string} chatId - Chat to convert
     * @param {string} targetMode - New mode
     */
    convertToMode(chatId, targetMode) {
        if (!this.chats[chatId]) return;
        const normalizedMode = normalizeSessionMode(targetMode);
        this.chats[chatId].mode = normalizedMode;
        this.chats[chatId].updatedAt = new Date().toISOString();
        this._persistChat(this.chats[chatId]);
        this._setCurrentMode(normalizedMode);
        eventBus.emit(Events.CHAT_UPDATED, { id: chatId, chat: this.chats[chatId] });
    }
}

// Export singleton instance
export const chatService = new ChatService();
