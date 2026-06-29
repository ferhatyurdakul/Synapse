/**
 * backupService — local-first backup/restore and self-host operations helpers.
 */
import {
    DB_VERSION,
    listStoreNames,
    getAllRecords,
    putRecords,
    clearStore,
    countRecords
} from './idbStore.js';
import { providerManager } from './providerManager.js';

const BACKUP_SCHEMA = 'synapse.backup.v1';
const LOCAL_STORAGE_KEYS = [
    'synapse_theme',
    'synapse_appearance',
    'synapse_voice_settings',
    'synapse_sidebar_state'
];

const COVERAGE = [
    { label: 'Chats and folders', stores: ['chats', 'messages', 'folders'], note: 'Conversation tree, messages, modes, folder organization.' },
    { label: 'Uploaded/generated media', stores: ['attachments', 'images', 'imageFolders', 'imageVersions'], note: 'Chat attachments and gallery records; binary payloads are included when already stored in IndexedDB records.' },
    { label: 'Documents and RAG', stores: ['documents', 'documentVersions', 'ragCollections', 'ragDocuments', 'ragChunks', 'ragEmbeddings'], note: 'Document library metadata, versions, chunks, and local embeddings.' },
    { label: 'Notes, tasks, reports', stores: ['workItems', 'researchReports'], note: 'Workspace notes/tasks and saved research reports.' },
    { label: 'Memory and skills', stores: ['memoryEntries', 'memoryEmbeddings', 'skills', 'templates'], note: 'Opt-in personal memory, embeddings, reusable workflows, and prompt templates.' },
    { label: 'Settings and UI state', stores: ['settings', 'modelSettings', 'uiState'], localStorage: LOCAL_STORAGE_KEYS, note: 'Provider URLs, model parameters, appearance, voice, and UI preferences.' },
    { label: 'Integrations and agent operations', stores: ['mcpServers', 'agentRuns', 'agentRunEvents', 'compareSessions'], note: 'MCP registry, agent run history, and compare/committee sessions.' },
    { label: 'People, calendar, email', stores: ['contacts', 'calendars', 'calendarEvents', 'emailAccounts', 'emailFolders', 'emailMessages'], note: 'Local-first workspace data; external credentials/sync tokens are not created by backup.' },
    { label: 'Local model cookbook', stores: ['modelRemoteProfiles', 'modelRunbooks', 'modelBenchmarks'], note: 'Hardware-aware model setup profiles, install-later runbooks, and benchmark evidence.' }
];

function nowIso() {
    return new Date().toISOString();
}

function filenameTimestamp() {
    return nowIso().replace(/[:.]/g, '-');
}

function safeJsonParse(text) {
    try {
        return { ok: true, value: JSON.parse(text) };
    } catch (error) {
        return { ok: false, error };
    }
}

function readLocalStorage() {
    const values = {};
    for (const key of LOCAL_STORAGE_KEYS) {
        const value = localStorage.getItem(key);
        if (value !== null) values[key] = value;
    }
    return values;
}

async function collectStoreCounts(storeNames = listStoreNames()) {
    const counts = {};
    for (const store of storeNames) {
        try {
            counts[store] = await countRecords(store);
        } catch (error) {
            counts[store] = { error: error.message };
        }
    }
    return counts;
}

class BackupService {
    constructor() {
        this.lastPreview = null;
    }

    getCoverage() {
        const stores = new Set(listStoreNames());
        return COVERAGE.map(group => ({
            ...group,
            stores: group.stores.map(name => ({ name, available: stores.has(name) }))
        }));
    }

    async createBackup({ stores = listStoreNames(), includeLocalStorage = true } = {}) {
        const selectedStores = stores.filter(store => listStoreNames().includes(store));
        const data = {};
        const counts = {};

        for (const store of selectedStores) {
            const records = await getAllRecords(store);
            data[store] = records;
            counts[store] = records.length;
        }

        return {
            schema: BACKUP_SCHEMA,
            createdAt: nowIso(),
            app: 'Synapse',
            dbName: 'synapse_db',
            dbVersion: DB_VERSION,
            stores: selectedStores,
            counts,
            localStorage: includeLocalStorage ? readLocalStorage() : {},
            data,
            guidance: {
                restore: 'Always preview first. Restore replaces selected stores when applyRestore is called with overwrite=true.',
                retention: 'Keep at least 7 daily, 4 weekly, and 6 monthly backups for self-hosted instances.',
                privacy: 'Backups may contain chats, documents, memories, email metadata, and local settings. Store encrypted when syncing off-device.'
            }
        };
    }

    downloadBackup(backup) {
        const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `synapse-backup-${filenameTimestamp()}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    async previewBackupFile(file) {
        const text = await file.text();
        return this.previewBackupText(text);
    }

    previewBackupText(text) {
        const parsed = safeJsonParse(text);
        if (!parsed.ok) {
            return { valid: false, errors: [`Invalid JSON: ${parsed.error.message}`], warnings: [], stores: [], counts: {}, backup: null };
        }
        return this.previewBackup(parsed.value);
    }

    previewBackup(backup) {
        const errors = [];
        const warnings = [];
        const currentStores = new Set(listStoreNames());
        if (!backup || typeof backup !== 'object') errors.push('Backup must be a JSON object.');
        if (backup?.schema !== BACKUP_SCHEMA) warnings.push(`Unexpected schema: ${backup?.schema || 'missing'}; expected ${BACKUP_SCHEMA}.`);
        if (!backup?.data || typeof backup.data !== 'object') errors.push('Backup is missing a data object.');

        const stores = Object.keys(backup?.data || {});
        for (const store of stores) {
            if (!currentStores.has(store)) warnings.push(`Store ${store} is not in the current Synapse schema and will be skipped.`);
            if (!Array.isArray(backup.data[store])) errors.push(`Store ${store} must contain an array of records.`);
        }

        const preview = {
            valid: errors.length === 0,
            errors,
            warnings,
            schema: backup?.schema,
            createdAt: backup?.createdAt,
            dbVersion: backup?.dbVersion,
            stores: stores.filter(store => currentStores.has(store)),
            skippedStores: stores.filter(store => !currentStores.has(store)),
            counts: Object.fromEntries(stores.map(store => [store, Array.isArray(backup?.data?.[store]) ? backup.data[store].length : 0])),
            localStorageKeys: Object.keys(backup?.localStorage || {}),
            backup
        };
        this.lastPreview = preview;
        return preview;
    }

    async applyRestore(previewOrBackup, { stores = null, overwrite = true, restoreLocalStorage = true } = {}) {
        const preview = previewOrBackup?.backup ? previewOrBackup : this.previewBackup(previewOrBackup);
        if (!preview.valid) throw new Error(`Restore preview is invalid: ${preview.errors.join('; ')}`);
        const selectedStores = (stores || preview.stores).filter(store => preview.stores.includes(store));
        const restored = {};

        for (const store of selectedStores) {
            const records = preview.backup.data[store] || [];
            if (overwrite) await clearStore(store);
            await putRecords(store, records);
            restored[store] = records.length;
        }

        const restoredLocalStorage = [];
        if (restoreLocalStorage) {
            for (const [key, value] of Object.entries(preview.backup.localStorage || {})) {
                localStorage.setItem(key, value);
                restoredLocalStorage.push(key);
            }
        }

        return { restored, restoredLocalStorage, appliedAt: nowIso(), overwrite };
    }

    async getHealthReport() {
        const provider = providerManager.getProvider();
        const providerLabel = providerManager.getProviderLabel();
        const quota = navigator.storage?.estimate ? await navigator.storage.estimate() : null;
        const counts = await collectStoreCounts();
        let providerReachable = false;
        let providerError = null;
        try {
            providerReachable = await provider.isServerAvailable();
        } catch (error) {
            providerError = error.message;
        }

        const usageRatio = quota?.quota ? quota.usage / quota.quota : null;
        const checks = [
            { id: 'indexeddb', label: 'IndexedDB available', status: Boolean(window.indexedDB) ? 'ok' : 'critical', detail: window.indexedDB ? `Schema v${DB_VERSION}` : 'IndexedDB is unavailable.' },
            { id: 'storage-quota', label: 'Storage quota', status: usageRatio == null ? 'unknown' : usageRatio > 0.9 ? 'critical' : usageRatio > 0.75 ? 'warning' : 'ok', detail: quota ? `${Math.round((quota.usage || 0) / 1024 / 1024)} MB used of ${Math.round((quota.quota || 0) / 1024 / 1024)} MB` : 'Storage estimate API unavailable.' },
            { id: 'provider', label: `${providerLabel} reachability`, status: providerReachable ? 'ok' : 'warning', detail: providerReachable ? 'Active provider responded.' : (providerError || 'Active provider is unreachable; AI features are degraded.') },
            { id: 'server-mode', label: 'Server mode', status: location.protocol === 'file:' ? 'warning' : 'ok', detail: location.protocol === 'file:' ? 'Use python3 server.py for proxy/PWA/self-host checks.' : `${location.protocol}//${location.host}` },
            { id: 'service-worker', label: 'PWA capability', status: 'serviceWorker' in navigator ? 'ok' : 'warning', detail: 'serviceWorker' in navigator ? 'Browser supports service workers.' : 'Browser lacks service worker support.' },
            { id: 'crypto', label: 'Secure crypto', status: window.crypto?.subtle ? 'ok' : 'warning', detail: window.crypto?.subtle ? 'WebCrypto available for future encrypted backup support.' : 'WebCrypto unavailable.' }
        ];

        return { generatedAt: nowIso(), dbVersion: DB_VERSION, counts, quota, checks };
    }

    getOperationsGuide() {
        return {
            manualBackup: ['Open Ops', 'Click Create Backup', 'Store the JSON somewhere encrypted/off-device.', 'Test restore preview after major changes.'],
            scheduledBackups: ['Synapse cannot run browser backups while closed.', 'For self-hosting, set an OS reminder/cron to open Synapse and export daily or pair browser data directory snapshots with this JSON export.', 'Suggested retention: 7 daily, 4 weekly, 6 monthly.'],
            deployment: ['Localhost: python3 server.py and open http://localhost:8000.', 'LAN/mobile: bind behind a trusted LAN/VPN and avoid exposing unauthenticated local model endpoints.', 'Hosted/reverse proxy: terminate TLS, set body-size limits for media, protect with auth, and proxy to server.py or a static host plus API proxy.', 'Service packaging: run server.py under systemd/launchd/Task Scheduler; back up the browser profile or use export JSON before upgrades.'],
            recovery: ['If restore fails, keep the backup JSON untouched and refresh the page.', 'Preview again and restore fewer stores first, starting with settings/chats.', 'If IndexedDB is corrupt, export what still loads, clear site data, reload, then restore from JSON.', 'Provider/API failures do not block restore; they only degrade AI features until endpoints recover.']
        };
    }
}

export const backupService = new BackupService();
export default backupService;
