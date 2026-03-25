/**
 * StorageService — Persistence layer backed by IndexedDB.
 *
 * Design:
 *   - Settings, folders, model settings, UI state: synchronous in-memory cache,
 *     async write-behind to IndexedDB. loadSettings() etc. remain sync.
 *   - Chats & messages: async methods for granular per-record reads/writes.
 *   - Attachments (images): stored as Blobs in their own object store.
 *   - One-time migration from localStorage on first init().
 *
 * Callers must `await storageService.init()` once at startup before using
 * any methods. After init, cached reads are synchronous.
 */

import {
    openDatabase,
    putRecord, putRecords, getRecord, getAllRecords,
    getRecordsByIndex, deleteRecord, deleteByIndex,
    clearStore, countRecords
} from './idbStore.js?v=35';

// localStorage keys (used only for migration detection + fallback)
const LS_PREFIX = 'synapse_';
const LS_CHATS = `${LS_PREFIX}chats`;
const LS_SETTINGS = `${LS_PREFIX}settings`;
const LS_FOLDERS = `${LS_PREFIX}folders`;
const LS_MODEL_SETTINGS = `${LS_PREFIX}model_settings`;
const LS_SIDEBAR = 'sidebar-collapsed';
const LS_MIGRATED = 'synapse_idb_migrated';

class StorageService {
    constructor() {
        /** @type {Object|null} */ this._settingsCache = null;
        /** @type {Object|null} */ this._foldersCache = null;
        /** @type {Object|null} */ this._modelSettingsCache = null;
        /** @type {Object}      */ this._uiStateCache = {};
        /** @type {boolean}     */ this._ready = false;
        /** @type {Promise|null}*/ this._initPromise = null;

        // Write coalescing for chat metadata
        /** @type {Map<string, Object>} */ this._pendingChatWrites = new Map();
        /** @type {boolean} */ this._chatWriteScheduled = false;
    }

    // ─── Initialization ──────────────────────────────────────────────────────

    /**
     * Initialize the storage backend. Must be called once before other methods.
     * Runs migration from localStorage if needed, then loads caches.
     * @returns {Promise<void>}
     */
    async init() {
        if (this._ready) return;
        if (this._initPromise) return this._initPromise;

        this._initPromise = this._doInit();
        await this._initPromise;
        this._ready = true;
    }

    /** @private */
    async _doInit() {
        await openDatabase();
        await this._migrateFromLocalStorage();

        // Load caches
        const settingsRec = await getRecord('settings', 'app');
        this._settingsCache = settingsRec?.value || this.getDefaultSettings();

        const foldersArr = await getAllRecords('folders');
        this._foldersCache = {};
        for (const f of foldersArr) this._foldersCache[f.id] = f;

        const msRec = await getRecord('modelSettings', 'all');
        this._modelSettingsCache = msRec?.value || {};

        const sidebarRec = await getRecord('uiState', 'sidebar-collapsed');
        this._uiStateCache['sidebar-collapsed'] = sidebarRec?.value || false;
    }

    // ─── Settings (sync read, async write-behind) ────────────────────────────

    getDefaultSettings() {
        return {
            selectedProvider: 'ollama',
            selectedModel: null,
            thinkingCollapsed: true,
            sidebarOpen: true,
            titleProvider: 'ollama',
            titleModel: 'gemma3:1b',
            titleEnabled: true,
            summarizationEnabled: true,
            toolsEnabled: true,
            systemPrompt: ''
        };
    }

    /** @returns {Object} Settings (sync, from cache) */
    loadSettings() {
        return this._settingsCache || this.getDefaultSettings();
    }

    /** Updates cache immediately, persists to IDB async. */
    saveSettings(settings) {
        this._settingsCache = settings;
        putRecord('settings', { key: 'app', value: settings }).catch(
            e => console.error('Failed to save settings:', e)
        );
    }

    // ─── Folders (sync read, async write-behind) ─────────────────────────────

    /** @returns {Object} Folders map keyed by ID (sync) */
    loadFolders() {
        return this._foldersCache || {};
    }

    /** Updates cache immediately, persists to IDB async. */
    saveFolders(folders) {
        this._foldersCache = folders;
        const records = Object.values(folders);
        // Clear then rewrite (handles deletions)
        clearStore('folders')
            .then(() => putRecords('folders', records))
            .catch(e => console.error('Failed to save folders:', e));
    }

    // ─── Model settings (sync read, async write-behind) ──────────────────────

    /** @returns {Object} All model settings (sync) */
    loadModelSettings() {
        return this._modelSettingsCache || {};
    }

    saveModelSettings(allSettings) {
        this._modelSettingsCache = allSettings;
        putRecord('modelSettings', { key: 'all', value: allSettings }).catch(
            e => console.error('Failed to save model settings:', e)
        );
    }

    // ─── UI state (sync read, async write-behind) ────────────────────────────

    loadSidebarState() {
        return this._uiStateCache['sidebar-collapsed'] || false;
    }

    saveSidebarState(collapsed) {
        this._uiStateCache['sidebar-collapsed'] = collapsed;
        putRecord('uiState', { key: 'sidebar-collapsed', value: collapsed }).catch(
            e => console.error('Failed to save sidebar state:', e)
        );
    }

    // ─── Chats (async, granular) ─────────────────────────────────────────────

    /**
     * Load all chat metadata (without messages).
     * @returns {Promise<Object>} Map of chatId -> chat metadata
     */
    async loadAllChats() {
        const records = await getAllRecords('chats');
        const chats = {};
        for (const chat of records) {
            chats[chat.id] = chat;
        }
        return chats;
    }

    /**
     * Load all messages for a specific chat, ordered by timestamp.
     * @param {string} chatId
     * @returns {Promise<Object[]>}
     */
    async loadMessagesForChat(chatId) {
        const messages = await getRecordsByIndex('messages', 'chatId', chatId);
        messages.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
        return messages;
    }

    /**
     * Save chat metadata (no messages). Uses write coalescing.
     * @param {Object} chat - Chat metadata object
     */
    saveChat(chat) {
        this._pendingChatWrites.set(chat.id, { ...chat });
        if (!this._chatWriteScheduled) {
            this._chatWriteScheduled = true;
            queueMicrotask(() => this._flushChatWrites());
        }
    }

    /** @private */
    async _flushChatWrites() {
        this._chatWriteScheduled = false;
        const batch = [...this._pendingChatWrites.values()];
        this._pendingChatWrites.clear();
        if (batch.length === 0) return;
        try {
            await putRecords('chats', batch);
        } catch (e) {
            console.error('Failed to flush chat writes:', e);
        }
    }

    /**
     * Save a single message.
     * @param {string} chatId
     * @param {Object} message
     * @returns {Promise<void>}
     */
    async saveMessage(chatId, message) {
        // Strip hydrated images from persisted copy (attachmentIds is the source of truth)
        const record = { ...message, chatId };
        if (record.attachmentIds) delete record.images;
        await putRecord('messages', record);
    }

    /**
     * Save multiple messages in a single transaction.
     * @param {string} chatId
     * @param {Object[]} messages
     * @returns {Promise<void>}
     */
    async saveMessages(chatId, messages) {
        const records = messages.map(m => {
            const record = { ...m, chatId };
            if (record.attachmentIds) delete record.images;
            return record;
        });
        await putRecords('messages', records);
    }

    /**
     * Delete a chat and all its messages and attachments.
     * @param {string} chatId
     * @returns {Promise<void>}
     */
    async deleteChat(chatId) {
        this._pendingChatWrites.delete(chatId);
        await deleteRecord('chats', chatId);
        await deleteByIndex('messages', 'chatId', chatId);
        await deleteByIndex('attachments', 'chatId', chatId);
    }

    /**
     * Delete all messages for a chat.
     * @param {string} chatId
     * @returns {Promise<void>}
     */
    async deleteMessagesForChat(chatId) {
        await deleteByIndex('messages', 'chatId', chatId);
    }

    // ─── Attachments ─────────────────────────────────────────────────────────

    /**
     * Save an image attachment as a Blob.
     * @param {string} id - Attachment ID
     * @param {string} chatId
     * @param {string} messageId
     * @param {Blob} blob
     * @param {string} mimeType
     * @returns {Promise<void>}
     */
    async saveAttachment(id, chatId, messageId, blob, mimeType) {
        await putRecord('attachments', { id, chatId, messageId, blob, mimeType });
    }

    /**
     * Get an attachment by ID.
     * @param {string} id
     * @returns {Promise<Object|undefined>} { id, chatId, messageId, blob, mimeType }
     */
    async getAttachment(id) {
        return getRecord('attachments', id);
    }

    /**
     * Get all attachments for a chat.
     * @param {string} chatId
     * @returns {Promise<Object[]>}
     */
    async getAttachmentsForChat(chatId) {
        return getRecordsByIndex('attachments', 'chatId', chatId);
    }

    /**
     * Delete all attachments for a chat.
     * @param {string} chatId
     * @returns {Promise<void>}
     */
    async deleteAttachmentsForChat(chatId) {
        await deleteByIndex('attachments', 'chatId', chatId);
    }

    // ─── Export / Import ─────────────────────────────────────────────────────

    /**
     * Export all chats as JSON string (reconstitutes full chat objects with messages).
     * @returns {Promise<string>}
     */
    async exportChats() {
        const chats = await this.loadAllChats();
        for (const chatId of Object.keys(chats)) {
            const messages = await this.loadMessagesForChat(chatId);
            // Hydrate images for export
            for (const msg of messages) {
                if (msg.attachmentIds && msg.attachmentIds.length > 0) {
                    msg.images = [];
                    for (const attId of msg.attachmentIds) {
                        const att = await this.getAttachment(attId);
                        if (att?.blob) {
                            msg.images.push(await this._blobToDataUrl(att.blob));
                        }
                    }
                    delete msg.attachmentIds;
                }
                // Remove the chatId field added for IDB indexing
                delete msg.chatId;
            }
            chats[chatId].messages = messages;
        }
        return JSON.stringify(chats, null, 2);
    }

    /**
     * Import chats from JSON string.
     * @param {string} jsonString
     * @param {boolean} merge
     * @returns {Promise<Object>} Imported/merged chats (with messages attached for chatService)
     */
    async importChats(jsonString, merge = true) {
        const importedChats = JSON.parse(jsonString);

        let existingChats = {};
        if (merge) {
            existingChats = await this.loadAllChats();
        }

        const mergedChats = { ...existingChats };

        for (const [chatId, chat] of Object.entries(importedChats)) {
            const messages = chat.messages || [];
            delete chat.messages;

            // Save chat metadata
            await putRecord('chats', chat);
            mergedChats[chatId] = chat;

            // Save messages (with attachment extraction)
            for (const msg of messages) {
                if (msg.images && msg.images.length > 0) {
                    msg.attachmentIds = [];
                    for (const dataUrl of msg.images) {
                        const attId = this._generateId();
                        const blob = this._dataUrlToBlob(dataUrl);
                        await this.saveAttachment(attId, chatId, msg.id, blob, blob.type);
                        msg.attachmentIds.push(attId);
                    }
                    delete msg.images;
                }
                await putRecord('messages', { ...msg, chatId });
            }

            // Re-attach messages in memory for chatService
            mergedChats[chatId].messages = messages;
        }

        return mergedChats;
    }

    // ─── Bulk operations ─────────────────────────────────────────────────────

    /**
     * Clear chats, messages, attachments, and folders (preserves settings).
     * @returns {Promise<void>}
     */
    async clearChats() {
        await clearStore('chats');
        await clearStore('messages');
        await clearStore('attachments');
        await clearStore('folders');
        this._foldersCache = {};
    }

    /**
     * Clear all stored data including settings.
     * @returns {Promise<void>}
     */
    async clearAll() {
        await clearStore('chats');
        await clearStore('messages');
        await clearStore('attachments');
        await clearStore('settings');
        await clearStore('folders');
        await clearStore('modelSettings');
        await clearStore('uiState');

        this._settingsCache = this.getDefaultSettings();
        this._foldersCache = {};
        this._modelSettingsCache = {};
        this._uiStateCache = {};
    }

    /**
     * Get storage usage info.
     * @returns {Promise<Object>}
     */
    async getStorageInfo() {
        let estimate = { usage: 0, quota: 0 };
        if (navigator.storage?.estimate) {
            estimate = await navigator.storage.estimate();
        }

        const chatCount = await countRecords('chats');
        const messageCount = await countRecords('messages');
        const attachmentCount = await countRecords('attachments');

        return {
            used: estimate.usage || 0,
            quota: estimate.quota || 0,
            chatCount,
            messageCount,
            attachmentCount
        };
    }

    // ─── Migration from localStorage ─────────────────────────────────────────

    /** @private */
    async _migrateFromLocalStorage() {
        try {
            if (localStorage.getItem(LS_MIGRATED) === 'true') return;

            // Check if there's any localStorage data to migrate
            const hasData = localStorage.getItem(LS_CHATS) ||
                            localStorage.getItem(LS_SETTINGS) ||
                            localStorage.getItem(LS_FOLDERS) ||
                            localStorage.getItem(LS_MODEL_SETTINGS) ||
                            localStorage.getItem(LS_SIDEBAR);

            if (!hasData) {
                localStorage.setItem(LS_MIGRATED, 'true');
                return;
            }

            console.log('[Synapse] Migrating data from localStorage to IndexedDB...');

            // Migrate settings
            const settingsStr = localStorage.getItem(LS_SETTINGS);
            if (settingsStr) {
                const settings = JSON.parse(settingsStr);
                await putRecord('settings', { key: 'app', value: settings });
            }

            // Migrate folders
            const foldersStr = localStorage.getItem(LS_FOLDERS);
            if (foldersStr) {
                const folders = JSON.parse(foldersStr);
                const records = Object.values(folders);
                if (records.length > 0) await putRecords('folders', records);
            }

            // Migrate model settings
            const msStr = localStorage.getItem(LS_MODEL_SETTINGS);
            if (msStr) {
                const ms = JSON.parse(msStr);
                await putRecord('modelSettings', { key: 'all', value: ms });
            }

            // Migrate sidebar state
            const sidebarVal = localStorage.getItem(LS_SIDEBAR);
            if (sidebarVal !== null) {
                await putRecord('uiState', {
                    key: 'sidebar-collapsed',
                    value: sidebarVal === 'true'
                });
            }

            // Migrate chats (split into metadata + messages + attachments)
            const chatsStr = localStorage.getItem(LS_CHATS);
            if (chatsStr) {
                const chats = JSON.parse(chatsStr);

                for (const [chatId, chat] of Object.entries(chats)) {
                    const messages = chat.messages || [];
                    const chatMeta = { ...chat };
                    delete chatMeta.messages;

                    // Save chat metadata
                    await putRecord('chats', chatMeta);

                    // Process messages
                    for (const msg of messages) {
                        // Extract images to attachment store
                        if (msg.images && msg.images.length > 0) {
                            msg.attachmentIds = [];
                            for (const dataUrl of msg.images) {
                                try {
                                    const attId = this._generateId();
                                    const blob = this._dataUrlToBlob(dataUrl);
                                    await this.saveAttachment(attId, chatId, msg.id, blob, blob.type);
                                    msg.attachmentIds.push(attId);
                                } catch (e) {
                                    console.warn(`[Synapse] Failed to migrate image in message ${msg.id}:`, e);
                                }
                            }
                            delete msg.images;
                        }

                        // Save message with chatId for indexing
                        await putRecord('messages', { ...msg, chatId });
                    }
                }
            }

            localStorage.setItem(LS_MIGRATED, 'true');
            console.log('[Synapse] Migration complete.');
        } catch (error) {
            console.error('[Synapse] Migration failed:', error);
            window.dispatchEvent(new CustomEvent('synapse:migrationFailed', { detail: error }));
        }
    }

    // ─── Utilities ───────────────────────────────────────────────────────────

    /** @private */
    _generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }

    /** @private */
    _dataUrlToBlob(dataUrl) {
        const [header, base64] = dataUrl.split(',');
        const mime = header.match(/:(.*?);/)?.[1] || 'image/png';
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new Blob([bytes], { type: mime });
    }

    /** @private */
    _blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
        });
    }

    /**
     * Hydrate images for messages that have attachmentIds.
     * Converts Blobs back to data URLs for rendering.
     * @param {Object[]} messages
     * @returns {Promise<void>}
     */
    async hydrateAttachments(messages) {
        for (const msg of messages) {
            if (msg.attachmentIds && msg.attachmentIds.length > 0) {
                msg.images = [];
                for (const attId of msg.attachmentIds) {
                    try {
                        const att = await this.getAttachment(attId);
                        if (att?.blob) {
                            msg.images.push(await this._blobToDataUrl(att.blob));
                        }
                    } catch (e) {
                        console.warn(`Failed to hydrate attachment ${attId}:`, e);
                    }
                }
            }
        }
    }

    /**
     * Extract images from a message and save as attachments.
     * Replaces message.images with message.attachmentIds.
     * @param {string} chatId
     * @param {Object} message - Message object (mutated in place)
     * @returns {Promise<void>}
     */
    async extractAttachments(chatId, message) {
        if (!message.images || message.images.length === 0) return;

        message.attachmentIds = [];
        for (const dataUrl of message.images) {
            const attId = this._generateId();
            const blob = this._dataUrlToBlob(dataUrl);
            await this.saveAttachment(attId, chatId, message.id, blob, blob.type);
            message.attachmentIds.push(attId);
        }
        // Keep images in memory for current session rendering,
        // but the persisted message (in IDB) won't have images[]
    }
}

// Export singleton instance
export const storageService = new StorageService();
