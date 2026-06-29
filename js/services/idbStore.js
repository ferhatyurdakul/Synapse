/**
 * idbStore — Low-level IndexedDB wrapper for Synapse.
 *
 * Database: 'synapse_db'
 * Provides async CRUD primitives used by storageService.
 * No external dependencies.
 */

const DB_NAME = 'synapse_db';
export const DB_VERSION = 17;

/** @type {IDBDatabase|null} */
let _db = null;

/**
 * Store definitions for the onupgradeneeded handler.
 * Each entry: { keyPath, indexes: [{ name, keyPath, options }] }
 * version: minimum DB version that introduced this store (default 1)
 */
const STORES = {
    chats: {
        keyPath: 'id',
        indexes: [
            { name: 'updatedAt', keyPath: 'updatedAt' },
            { name: 'folderId', keyPath: 'folderId' },
            { name: 'parentChatId', keyPath: 'parentChatId' }
        ]
    },
    messages: {
        keyPath: 'id',
        indexes: [
            { name: 'chatId', keyPath: 'chatId' },
            { name: 'chatId_timestamp', keyPath: ['chatId', 'timestamp'] }
        ]
    },
    attachments: {
        keyPath: 'id',
        indexes: [
            { name: 'chatId', keyPath: 'chatId' },
            { name: 'messageId', keyPath: 'messageId' }
        ]
    },
    settings: { keyPath: 'key' },
    folders: { keyPath: 'id' },
    modelSettings: { keyPath: 'key' },
    uiState: { keyPath: 'key' },
    templates: {
        version: 4,
        keyPath: 'id',
        indexes: [
            { name: 'updatedAt', keyPath: 'updatedAt' }
        ]
    },
    agentRuns: {
        version: 5,
        keyPath: 'id',
        indexes: [
            { name: 'chatId', keyPath: 'chatId' },
            { name: 'status', keyPath: 'status' },
            { name: 'updatedAt', keyPath: 'updatedAt' },
            { name: 'startedAt', keyPath: 'startedAt' }
        ]
    },
    agentRunEvents: {
        version: 5,
        keyPath: 'id',
        indexes: [
            { name: 'runId', keyPath: 'runId' },
            { name: 'chatId', keyPath: 'chatId' },
            { name: 'timestamp', keyPath: 'timestamp' },
            { name: 'runId_timestamp', keyPath: ['runId', 'timestamp'] }
        ]
    },

    // ── RAG stores (v2) ─────────────────────────────────────────────────
    ragCollections: {
        version: 2,
        keyPath: 'id',
        indexes: [
            { name: 'createdAt', keyPath: 'createdAt' }
        ]
    },
    ragDocuments: {
        version: 2,
        keyPath: 'id',
        indexes: [
            { name: 'collectionId', keyPath: 'collectionId' },
            { name: 'createdAt', keyPath: 'createdAt' }
        ]
    },
    ragChunks: {
        version: 2,
        keyPath: 'id',
        indexes: [
            { name: 'documentId', keyPath: 'documentId' },
            { name: 'collectionId', keyPath: 'collectionId' }
        ]
    },
    ragEmbeddings: {
        version: 2,
        keyPath: 'chunkId',
        indexes: [
            { name: 'collectionId', keyPath: 'collectionId' },
            { name: 'documentId', keyPath: 'documentId' }
        ]
    },

    // ── MCP stores (v6) ──────────────────────────────────────────────────
    mcpServers: {
        version: 6,
        keyPath: 'id',
        indexes: [
            { name: 'updatedAt', keyPath: 'updatedAt' }
        ]
    },

    // ── Semantic Memory stores (v7) ───────────────────────────────────────
    memoryEntries: {
        version: 7,
        keyPath: 'id',
        indexes: [
            { name: 'layer', keyPath: 'layer' },
            { name: 'projectId', keyPath: 'projectId' },
            { name: 'confidence', keyPath: 'confidence' },
            { name: 'createdAt', keyPath: 'createdAt' },
            { name: 'updatedAt', keyPath: 'updatedAt' },
            { name: 'sourceType', keyPath: 'source.type' },
            { name: 'projectId_layer', keyPath: ['projectId', 'layer'] }
        ]
    },
    memoryEmbeddings: {
        version: 7,
        keyPath: 'entryId',
        indexes: [
            { name: 'projectId', keyPath: 'projectId' },
            { name: 'layer', keyPath: 'layer' }
        ]
    },

    // ── Skills and reusable workflows (v8) ───────────────────────────────
    skills: {
        version: 8,
        keyPath: 'id',
        indexes: [
            { name: 'name', keyPath: 'name' },
            { name: 'origin', keyPath: 'origin' },
            { name: 'updatedAt', keyPath: 'updatedAt' }
        ]
    },

    // ── Document workspace and library (v9) ───────────────────────────────
    documents: {
        version: 9,
        keyPath: 'id',
        indexes: [
            { name: 'type', keyPath: 'type' },
            { name: 'status', keyPath: 'status' },
            { name: 'projectId', keyPath: 'projectId' },
            { name: 'origin', keyPath: 'origin' },
            { name: 'updatedAt', keyPath: 'updatedAt' }
        ]
    },
    documentVersions: {
        version: 9,
        keyPath: 'id',
        indexes: [
            { name: 'documentId', keyPath: 'documentId' },
            { name: 'createdAt', keyPath: 'createdAt' }
        ]
    },

    // ── Saved research report library (v10) ────────────────────────────────
    researchReports: {
        version: 10,
        keyPath: 'id',
        indexes: [
            { name: 'projectId', keyPath: 'projectId' },
            { name: 'topic', keyPath: 'topic' },
            { name: 'mode', keyPath: 'mode' },
            { name: 'status', keyPath: 'status' },
            { name: 'state', keyPath: 'state' },
            { name: 'createdAt', keyPath: 'createdAt' },
            { name: 'updatedAt', keyPath: 'updatedAt' },
            { name: 'sourceChatId', keyPath: 'sourceChatId' },
            { name: 'sourceRunId', keyPath: 'sourceRunId' }
        ]
    },

    // ── Notes and tasks workspace (v11) ────────────────────────────────────
    workItems: {
        version: 11,
        keyPath: 'id',
        indexes: [
            { name: 'type', keyPath: 'type' },
            { name: 'status', keyPath: 'status' },
            { name: 'priority', keyPath: 'priority' },
            { name: 'projectId', keyPath: 'projectId' },
            { name: 'listId', keyPath: 'listId' },
            { name: 'dueAt', keyPath: 'dueAt' },
            { name: 'updatedAt', keyPath: 'updatedAt' },
            { name: 'createdAt', keyPath: 'createdAt' }
        ]
    },

    // ── Multi-model compare / committee sessions (v12) ─────────────────────
    compareSessions: {
        version: 12,
        keyPath: 'id',
        indexes: [
            { name: 'mode', keyPath: 'mode' },
            { name: 'status', keyPath: 'status' },
            { name: 'blind', keyPath: 'blind' },
            { name: 'projectId', keyPath: 'projectId' },
            { name: 'updatedAt', keyPath: 'updatedAt' },
            { name: 'createdAt', keyPath: 'createdAt' }
        ]
    },

    // ── Contacts and people workspace (v13) ────────────────────────────────
    contacts: {
        version: 13,
        keyPath: 'id',
        indexes: [
            { name: 'name', keyPath: 'name' },
            { name: 'organization', keyPath: 'organization' },
            { name: 'favorite', keyPath: 'favorite' },
            { name: 'archived', keyPath: 'archived' },
            { name: 'updatedAt', keyPath: 'updatedAt' },
            { name: 'createdAt', keyPath: 'createdAt' }
        ]
    },

    // ── Image gallery and editor workspace (v14) ──────────────────────────
    images: {
        version: 14,
        keyPath: 'id',
        indexes: [
            { name: 'projectId', keyPath: 'projectId' },
            { name: 'folderId', keyPath: 'folderId' },
            { name: 'sourceType', keyPath: 'sourceType' },
            { name: 'sourceChatId', keyPath: 'sourceChatId' },
            { name: 'model', keyPath: 'model' },
            { name: 'favorite', keyPath: 'favorite' },
            { name: 'archived', keyPath: 'archived' },
            { name: 'createdAt', keyPath: 'createdAt' },
            { name: 'updatedAt', keyPath: 'updatedAt' }
        ]
    },
    imageFolders: {
        version: 14,
        keyPath: 'id',
        indexes: [
            { name: 'projectId', keyPath: 'projectId' },
            { name: 'name', keyPath: 'name' },
            { name: 'updatedAt', keyPath: 'updatedAt' }
        ]
    },
    imageVersions: {
        version: 14,
        keyPath: 'id',
        indexes: [
            { name: 'imageId', keyPath: 'imageId' },
            { name: 'createdAt', keyPath: 'createdAt' }
        ]
    },

    // ── Calendar workspace and scheduling (v15) ───────────────────────────
    calendars: {
        version: 15,
        keyPath: 'id',
        indexes: [
            { name: 'name', keyPath: 'name' },
            { name: 'enabled', keyPath: 'enabled' },
            { name: 'source', keyPath: 'source' },
            { name: 'updatedAt', keyPath: 'updatedAt' }
        ]
    },
    calendarEvents: {
        version: 15,
        keyPath: 'id',
        indexes: [
            { name: 'calendarId', keyPath: 'calendarId' },
            { name: 'startAt', keyPath: 'startAt' },
            { name: 'endAt', keyPath: 'endAt' },
            { name: 'sourceType', keyPath: 'sourceType' },
            { name: 'approvalStatus', keyPath: 'approvalStatus' },
            { name: 'importFingerprint', keyPath: 'importFingerprint' },
            { name: 'updatedAt', keyPath: 'updatedAt' }
        ]
    },

    // ── Email workspace and AI triage (v16) ───────────────────────────────
    emailAccounts: {
        version: 16,
        keyPath: 'id',
        indexes: [
            { name: 'address', keyPath: 'address' },
            { name: 'enabled', keyPath: 'enabled' },
            { name: 'provider', keyPath: 'provider' },
            { name: 'updatedAt', keyPath: 'updatedAt' }
        ]
    },
    emailFolders: {
        version: 16,
        keyPath: 'id',
        indexes: [
            { name: 'accountId', keyPath: 'accountId' },
            { name: 'role', keyPath: 'role' },
            { name: 'updatedAt', keyPath: 'updatedAt' }
        ]
    },
    emailMessages: {
        version: 16,
        keyPath: 'id',
        indexes: [
            { name: 'accountId', keyPath: 'accountId' },
            { name: 'folder', keyPath: 'folder' },
            { name: 'threadId', keyPath: 'threadId' },
            { name: 'date', keyPath: 'date' },
            { name: 'read', keyPath: 'read' },
            { name: 'starred', keyPath: 'starred' },
            { name: 'triageCategory', keyPath: 'triage.category' },
            { name: 'draftStatus', keyPath: 'draft.status' },
            { name: 'followUpDueAt', keyPath: 'followUp.dueAt' },
            { name: 'sourceType', keyPath: 'source.type' },
            { name: 'messageId', keyPath: 'messageId' },
            { name: 'updatedAt', keyPath: 'updatedAt' }
        ]
    },

    // ── Local model cookbook and hardware-aware setup (v17) ────────────────
    modelRemoteProfiles: {
        version: 17,
        keyPath: 'id',
        indexes: [
            { name: 'name', keyPath: 'name' },
            { name: 'provider', keyPath: 'provider' },
            { name: 'updatedAt', keyPath: 'updatedAt' }
        ]
    },
    modelRunbooks: {
        version: 17,
        keyPath: 'id',
        indexes: [
            { name: 'modelId', keyPath: 'modelId' },
            { name: 'provider', keyPath: 'provider' },
            { name: 'status', keyPath: 'status' },
            { name: 'createdAt', keyPath: 'createdAt' }
        ]
    },
    modelBenchmarks: {
        version: 17,
        keyPath: 'id',
        indexes: [
            { name: 'modelId', keyPath: 'modelId' },
            { name: 'provider', keyPath: 'provider' },
            { name: 'createdAt', keyPath: 'createdAt' }
        ]
    }
};

/**
 * List the names of every object store in the schema (in declaration order).
 * Used by backup/restore to enumerate coverage without drifting from the schema.
 * @returns {string[]}
 */
export function listStoreNames() {
    return Object.keys(STORES);
}

/**
 * Open (or create) the database. Returns the cached handle on subsequent calls.
 * @returns {Promise<IDBDatabase>}
 */
export function openDatabase() {
    if (_db) return Promise.resolve(_db);

    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            const oldVersion = event.oldVersion;

            for (const [storeName, config] of Object.entries(STORES)) {
                const storeVersion = config.version || 1;
                if (storeVersion > oldVersion && !db.objectStoreNames.contains(storeName)) {
                    // Create new stores
                    const store = db.createObjectStore(storeName, { keyPath: config.keyPath });
                    if (config.indexes) {
                        for (const idx of config.indexes) {
                            store.createIndex(idx.name, idx.keyPath, idx.options || {});
                        }
                    }
                } else if (db.objectStoreNames.contains(storeName) && config.indexes) {
                    // Add missing indexes to existing stores
                    const store = event.currentTarget.transaction.objectStore(storeName);
                    for (const idx of config.indexes) {
                        if (!store.indexNames.contains(idx.name)) {
                            store.createIndex(idx.name, idx.keyPath, idx.options || {});
                        }
                    }
                }
            }
        };

        request.onsuccess = (event) => {
            _db = event.target.result;
            _db.onversionchange = () => {
                _db.close();
                _db = null;
            };
            resolve(_db);
        };

        request.onerror = () => reject(request.error);
    });
}

/**
 * Wrap an IDBRequest in a Promise.
 * @param {IDBRequest} request
 * @returns {Promise<*>}
 */
function promisify(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Put (upsert) a single record.
 * @param {string} storeName
 * @param {Object} record
 * @returns {Promise<void>}
 */
export async function putRecord(storeName, record) {
    const db = await openDatabase();
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(record);
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Put multiple records in a single transaction.
 * @param {string} storeName
 * @param {Object[]} records
 * @returns {Promise<void>}
 */
export async function putRecords(storeName, records) {
    if (records.length === 0) return;
    const db = await openDatabase();
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    for (const record of records) {
        store.put(record);
    }
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Get a single record by primary key.
 * @param {string} storeName
 * @param {*} key
 * @returns {Promise<Object|undefined>}
 */
export async function getRecord(storeName, key) {
    const db = await openDatabase();
    const tx = db.transaction(storeName, 'readonly');
    return promisify(tx.objectStore(storeName).get(key));
}

/**
 * Get all records from a store.
 * @param {string} storeName
 * @returns {Promise<Object[]>}
 */
export async function getAllRecords(storeName) {
    const db = await openDatabase();
    const tx = db.transaction(storeName, 'readonly');
    return promisify(tx.objectStore(storeName).getAll());
}

/**
 * Get all records matching an index value.
 * @param {string} storeName
 * @param {string} indexName
 * @param {*} value
 * @returns {Promise<Object[]>}
 */
export async function getRecordsByIndex(storeName, indexName, value) {
    const db = await openDatabase();
    const tx = db.transaction(storeName, 'readonly');
    const index = tx.objectStore(storeName).index(indexName);
    return promisify(index.getAll(value));
}

/**
 * Delete a single record by primary key.
 * @param {string} storeName
 * @param {*} key
 * @returns {Promise<void>}
 */
export async function deleteRecord(storeName, key) {
    const db = await openDatabase();
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Delete all records matching an index value.
 * @param {string} storeName
 * @param {string} indexName
 * @param {*} value
 * @returns {Promise<void>}
 */
export async function deleteByIndex(storeName, indexName, value) {
    const db = await openDatabase();
    const tx = db.transaction(storeName, 'readwrite');
    const index = tx.objectStore(storeName).index(indexName);
    const request = index.openCursor(value);
    return new Promise((resolve, reject) => {
        request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor) {
                cursor.delete();
                cursor.continue();
            }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Clear all records from a store.
 * @param {string} storeName
 * @returns {Promise<void>}
 */
export async function clearStore(storeName) {
    const db = await openDatabase();
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).clear();
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Count records in a store.
 * @param {string} storeName
 * @returns {Promise<number>}
 */
export async function countRecords(storeName) {
    const db = await openDatabase();
    const tx = db.transaction(storeName, 'readonly');
    return promisify(tx.objectStore(storeName).count());
}

/**
 * Delete the entire database (for testing/reset).
 * @returns {Promise<void>}
 */
export function deleteDatabase() {
    if (_db) {
        _db.close();
        _db = null;
    }
    return new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(DB_NAME);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}
