/**
 * idbStore — Low-level IndexedDB wrapper for Synapse.
 *
 * Database: 'synapse_db'
 * Provides async CRUD primitives used by storageService.
 * No external dependencies.
 */

const DB_NAME = 'synapse_db';
const DB_VERSION = 1;

/** @type {IDBDatabase|null} */
let _db = null;

/**
 * Store definitions for the onupgradeneeded handler.
 * Each entry: { keyPath, indexes: [{ name, keyPath, options }] }
 */
const STORES = {
    chats: {
        keyPath: 'id',
        indexes: [
            { name: 'updatedAt', keyPath: 'updatedAt' },
            { name: 'folderId', keyPath: 'folderId' }
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
    uiState: { keyPath: 'key' }
};

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

            for (const [storeName, config] of Object.entries(STORES)) {
                if (!db.objectStoreNames.contains(storeName)) {
                    const store = db.createObjectStore(storeName, { keyPath: config.keyPath });
                    if (config.indexes) {
                        for (const idx of config.indexes) {
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
