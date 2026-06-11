/**
 * DiagnosticsService — Centralized health-check and degraded-state monitor.
 *
 * Defines diagnostic domains, runs lightweight health probes, tracks errors,
 * and provides recovery suggestions. Used by the DiagnosticsPanel UI.
 *
 * Domains:
 *   1. Model Providers  – Ollama / LM Studio connectivity
 *   2. Storage / Indexes – IndexedDB health, quota
 *   3. RAG / Memory      – Embedding service, vector collections
 *   4. Integrations      – Web search endpoints, backend tool runner
 *   5. Background Tasks  – Agent runs, tool execution status
 */

import { providerManager } from './providerManager.js';
import { ollamaService } from './ollamaService.js';
import { lmStudioService } from './lmStudioService.js';
import { storageService } from './storageService.js';
import { backendToolService } from './backendToolService.js';
import { mcpService } from './mcpService.js';
import { eventBus, Events } from '../utils/eventBus.js';

// ── Status constants ──────────────────────────────────────────────────────

export const HealthStatus = Object.freeze({
    HEALTHY:   'healthy',
    DEGRADED:  'degraded',
    OFFLINE:   'offline',
    UNKNOWN:   'unknown',
});

// ── Recovery suggestions ──────────────────────────────────────────────────

const RECOVERY = Object.freeze({
    provider_offline:       'Start the provider application or check the URL in Settings → Models.',
    provider_no_models:     'Pull or load a model. For Ollama: ollama pull <model>.',
    storage_full:           'Export your chats, then delete old ones to free space.',
    storage_error:          'Try reloading the page. If this persists, clear browser data for this site.',
    rag_no_embedding_model: 'Select an embedding model in Settings → Knowledge Base.',
    rag_provider_offline:   'The model provider must be running to generate embeddings.',
    search_no_provider:     'Enable a search provider (SearXNG, Brave, or Tavily) in Settings → Tools.',
    search_searxng_down:    'SearXNG is not reachable. Start it: docker run -p 8888:8080 searxng/searxng.',
    search_api_key_missing: 'Add the required API key in Settings → Tools.',
    backend_tools_down:     'The backend server (server.py) is not reachable. Start it: python3 server.py.',
    backend_tools_error:    'Backend tool execution failed. Check the server console for details.',
    mcp_not_configured:     'Add an MCP server in Settings → Tools → MCP Servers.',
    mcp_discovery_failed:   'Check the MCP endpoint/command, auth token, and schema compatibility, then run Discover again.',
});

// ── Domain definitions ────────────────────────────────────────────────────

export const Domains = Object.freeze({
    PROVIDERS:    'providers',
    STORAGE:      'storage',
    RAG:          'rag',
    INTEGRATIONS: 'integrations',
    TASKS:        'tasks',
});

const DOMAIN_META = {
    [Domains.PROVIDERS]:    { label: 'Model Providers',   icon: 'cpu' },
    [Domains.STORAGE]:      { label: 'Storage & Indexes', icon: 'database' },
    [Domains.RAG]:          { label: 'RAG / Memory',      icon: 'brain' },
    [Domains.INTEGRATIONS]: { label: 'Integrations',      icon: 'plug' },
    [Domains.TASKS]:        { label: 'Background Tasks',  icon: 'loader' },
};

// ── Error log ─────────────────────────────────────────────────────────────

const MAX_LOG_ENTRIES = 100;

// ── Service ───────────────────────────────────────────────────────────────

class DiagnosticsService {
    constructor() {
        /** @type {Map<string, {status: string, checks: object[], lastCheck: number, lastError: string|null}>} */
        this._results = new Map();
        /** @type {Array<{ts: number, domain: string, message: string, level: string}>} */
        this._errorLog = [];
        /** @type {boolean} */
        this._running = false;
        /** @type {Function|null} */
        this._onUpdate = null;

        // Wire into event bus to capture runtime errors
        this._listenForErrors();
    }

    // ─── Public API ────────────────────────────────────────────────────────

    /**
     * Run all health checks and return the full diagnostics snapshot.
     * @returns {Promise<object>}
     */
    async runAllChecks() {
        if (this._running) return this.getSnapshot();
        this._running = true;

        try {
            const [providers, storage, rag, integrations, tasks] = await Promise.allSettled([
                this._checkProviders(),
                this._checkStorage(),
                this._checkRAG(),
                this._checkIntegrations(),
                this._checkTasks(),
            ]);

            this._store(Domains.PROVIDERS,    providers);
            this._store(Domains.STORAGE,      storage);
            this._store(Domains.RAG,          rag);
            this._store(Domains.INTEGRATIONS, integrations);
            this._store(Domains.TASKS,        tasks);
        } finally {
            this._running = false;
        }

        this._onUpdate?.(this.getSnapshot());
        return this.getSnapshot();
    }

    /**
     * Get the current diagnostics snapshot (latest check results).
     * @returns {object}
     */
    getSnapshot() {
        const domains = {};
        for (const key of Object.values(Domains)) {
            const r = this._results.get(key);
            const meta = DOMAIN_META[key];
            domains[key] = {
                key,
                label: meta.label,
                icon: meta.icon,
                status: r?.status ?? HealthStatus.UNKNOWN,
                checks: r?.checks ?? [],
                lastCheck: r?.lastCheck ?? null,
                lastError: r?.lastError ?? null,
            };
        }
        return {
            domains,
            errorLog: this._errorLog.slice(-50),
            overallStatus: this._overallStatus(),
        };
    }

    /**
     * Register a callback for when diagnostics update.
     * @param {Function} fn
     */
    onUpdate(fn) {
        this._onUpdate = fn;
    }

    /**
     * Get the domain label.
     * @param {string} domainKey
     * @returns {string}
     */
    getDomainLabel(domainKey) {
        return DOMAIN_META[domainKey]?.label ?? domainKey;
    }

    /**
     * Get recovery suggestion for a given check error key.
     * @param {string} key
     * @returns {string}
     */
    getRecovery(key) {
        return RECOVERY[key] ?? 'Try reloading the page or consult the documentation.';
    }

    /**
     * Check if there's a docs link for a topic.
     * @param {string} topic
     * @returns {string|null}
     */
    getDocsLink(topic) {
        // README has sections on web search config, architecture, etc.
        const links = {
            providers:    'https://github.com/ferhatyurdakul/Synapse#model-providers',
            storage:      null,
            rag:          'https://github.com/ferhatyurdakul/Synapse#rag--knowledge-base',
            integrations: 'https://github.com/ferhatyurdakul/Synapse#web-search',
            tasks:        null,
            backup:       null,
            admin:        null,
        };
        return links[topic] ?? null;
    }

    // ─── Domain checks ─────────────────────────────────────────────────────

    /** @private */
    async _checkProviders() {
        const checks = [];
        let overallStatus = HealthStatus.HEALTHY;
        let lastError = null;

        // Ollama
        try {
            const ollamaOk = await ollamaService.isServerAvailable();
            let modelCount = 0;
            if (ollamaOk) {
                try {
                    const models = await ollamaService.listModels();
                    modelCount = models.length;
                } catch {
                    // Server is up but model listing failed — degraded
                }
            }
            checks.push({
                name: 'Ollama',
                status: ollamaOk ? HealthStatus.HEALTHY : HealthStatus.OFFLINE,
                detail: ollamaOk ? `Connected — ${modelCount} model(s)` : 'Not reachable',
                url: ollamaService.baseUrl,
                recoveryKey: ollamaOk ? null : 'provider_offline',
            });
            if (!ollamaOk) { overallStatus = HealthStatus.OFFLINE; lastError = 'Ollama not reachable'; }
        } catch (e) {
            checks.push({ name: 'Ollama', status: HealthStatus.OFFLINE, detail: _sanitize(e.message), recoveryKey: 'provider_offline' });
            overallStatus = HealthStatus.OFFLINE;
            lastError = _sanitize(e.message);
        }

        // LM Studio
        try {
            const lmOk = await lmStudioService.isServerAvailable();
            let modelCount = 0;
            if (lmOk) {
                try {
                    const models = await lmStudioService.listModels();
                    modelCount = models.length;
                } catch {
                    // Server is up but model listing failed
                }
            }
            checks.push({
                name: 'LM Studio',
                status: lmOk ? HealthStatus.HEALTHY : HealthStatus.OFFLINE,
                detail: lmOk ? `Connected — ${modelCount} model(s)` : 'Not reachable',
                url: lmStudioService.baseUrl,
                recoveryKey: lmOk ? null : 'provider_offline',
            });
            if (!lmOk && overallStatus === HealthStatus.HEALTHY) {
                overallStatus = HealthStatus.OFFLINE;
                lastError = 'LM Studio not reachable';
            }
        } catch (e) {
            checks.push({ name: 'LM Studio', status: HealthStatus.OFFLINE, detail: _sanitize(e.message), recoveryKey: 'provider_offline' });
            if (overallStatus === HealthStatus.HEALTHY) { overallStatus = HealthStatus.OFFLINE; lastError = _sanitize(e.message); }
        }

        // Active provider check
        const activeName = providerManager.getProviderName();
        const activeLabel = providerManager.getProviderLabel();
        const activeService = providerManager.getProvider();
        const activeOk = await activeService.isServerAvailable().catch(() => false);
        checks.push({
            name: `Active (${activeLabel})`,
            status: activeOk ? HealthStatus.HEALTHY : HealthStatus.OFFLINE,
            detail: activeOk ? 'Available' : 'Not reachable — chat will not work',
            recoveryKey: activeOk ? null : 'provider_offline',
        });
        if (!activeOk) { overallStatus = HealthStatus.OFFLINE; lastError = `${activeLabel} (active) not reachable`; }

        return { status: overallStatus, checks, lastError };
    }

    /** @private */
    async _checkStorage() {
        const checks = [];
        let overallStatus = HealthStatus.HEALTHY;
        let lastError = null;

        // IndexedDB availability
        try {
            const info = await storageService.getStorageInfo();
            const usedPct = info.quota > 0 ? ((info.used / info.quota) * 100).toFixed(1) : 0;

            checks.push({
                name: 'IndexedDB',
                status: info.used / info.quota > 0.9 ? HealthStatus.DEGRADED : HealthStatus.HEALTHY,
                detail: `${_fmtBytes(info.indexedDbUsed)} used across ${info.chatCount} chats, ${info.messageCount} messages`,
                recoveryKey: info.used / info.quota > 0.9 ? 'storage_full' : null,
            });

            checks.push({
                name: 'Browser Storage',
                status: Number(usedPct) > 90 ? HealthStatus.DEGRADED : HealthStatus.HEALTHY,
                detail: `${_fmtBytes(info.used)} / ${_fmtBytes(info.quota)} (${usedPct}%)`,
                recoveryKey: Number(usedPct) > 90 ? 'storage_full' : null,
            });

            if (Number(usedPct) > 90) { overallStatus = HealthStatus.DEGRADED; lastError = 'Storage nearing capacity'; }
        } catch (e) {
            checks.push({ name: 'IndexedDB', status: HealthStatus.OFFLINE, detail: _sanitize(e.message), recoveryKey: 'storage_error' });
            overallStatus = HealthStatus.OFFLINE;
            lastError = _sanitize(e.message);
        }

        return { status: overallStatus, checks, lastError };
    }

    /** @private */
    async _checkRAG() {
        const checks = [];
        let overallStatus = HealthStatus.UNKNOWN;
        let lastError = null;

        const settings = storageService.loadSettings();
        const providerName = providerManager.getProviderName();

        // Check if RAG is configured
        const embedModel = providerName === 'ollama'
            ? settings.ragEmbeddingsModelOllama
            : settings.ragEmbeddingsModelLmstudio;

        if (!embedModel) {
            checks.push({
                name: 'Embedding Model',
                status: HealthStatus.UNKNOWN,
                detail: 'No embedding model configured',
                recoveryKey: 'rag_no_embedding_model',
            });
            return { status: HealthStatus.UNKNOWN, checks, lastError: 'No embedding model configured' };
        }

        checks.push({
            name: 'Embedding Model',
            status: HealthStatus.HEALTHY,
            detail: `${embedModel} (${providerName})`,
            recoveryKey: null,
        });

        // Check provider availability for embeddings
        const providerOk = await providerManager.getProvider().isServerAvailable().catch(() => false);
        checks.push({
            name: 'Provider for Embeddings',
            status: providerOk ? HealthStatus.HEALTHY : HealthStatus.OFFLINE,
            detail: providerOk ? 'Available' : `${providerManager.getProviderLabel()} offline — embeddings unavailable`,
            recoveryKey: providerOk ? null : 'rag_provider_offline',
        });

        if (!providerOk) {
            overallStatus = HealthStatus.OFFLINE;
            lastError = 'Provider offline — RAG unavailable';
        } else {
            overallStatus = HealthStatus.HEALTHY;
        }

        return { status: overallStatus, checks, lastError };
    }

    /** @private */
    async _checkIntegrations() {
        const checks = [];
        let overallStatus = HealthStatus.UNKNOWN;
        let lastError = null;
        let anyConfigured = false;

        const settings = storageService.loadSettings();
        const searchProvider = settings.searchProvider || 'searxng';

        // SearXNG
        const searxngUrl = settings.searxngUrl || 'http://localhost:8888';
        if (searchProvider === 'searxng') {
            anyConfigured = true;
            try {
                const res = await fetch(`${searxngUrl}/healthz`, { method: 'GET', signal: AbortSignal.timeout(3000) }).catch(() => null);
                const ok = res?.ok;
                checks.push({
                    name: 'SearXNG',
                    status: ok ? HealthStatus.HEALTHY : HealthStatus.OFFLINE,
                    detail: ok ? `Connected at ${searxngUrl}` : `Not reachable at ${searxngUrl}`,
                    url: searxngUrl,
                    recoveryKey: ok ? null : 'search_searxng_down',
                });
                if (!ok) { overallStatus = HealthStatus.DEGRADED; lastError = 'SearXNG not reachable'; }
                else { overallStatus = HealthStatus.HEALTHY; }
            } catch {
                checks.push({ name: 'SearXNG', status: HealthStatus.OFFLINE, detail: `Not reachable at ${searxngUrl}`, url: searxngUrl, recoveryKey: 'search_searxng_down' });
                overallStatus = HealthStatus.DEGRADED;
                lastError = 'SearXNG not reachable';
            }
        }

        // Brave Search (proxied)
        if (searchProvider === 'brave') {
            anyConfigured = true;
            const hasKey = !!settings.braveApiKey;
            checks.push({
                name: 'Brave Search',
                status: hasKey ? HealthStatus.HEALTHY : HealthStatus.OFFLINE,
                detail: hasKey ? 'API key configured' : 'API key missing',
                recoveryKey: hasKey ? null : 'search_api_key_missing',
            });
            if (!hasKey) { overallStatus = HealthStatus.OFFLINE; lastError = 'Brave API key missing'; }
            else { overallStatus = HealthStatus.HEALTHY; }
        }

        // Tavily (proxied)
        if (searchProvider === 'tavily') {
            anyConfigured = true;
            const hasKey = !!settings.tavilyApiKey;
            checks.push({
                name: 'Tavily',
                status: hasKey ? HealthStatus.HEALTHY : HealthStatus.OFFLINE,
                detail: hasKey ? 'API key configured' : 'API key missing',
                recoveryKey: hasKey ? null : 'search_api_key_missing',
            });
            if (!hasKey) { overallStatus = HealthStatus.OFFLINE; lastError = 'Tavily API key missing'; }
            else { overallStatus = HealthStatus.HEALTHY; }
        }

        // Backend tool runner
        try {
            const tools = await backendToolService.listTools({ signal: AbortSignal.timeout(3000) });
            const toolNames = (tools?.tools || []).map(t => t.name);
            checks.push({
                name: 'Backend Tools',
                status: HealthStatus.HEALTHY,
                detail: `${toolNames.length} tool(s) available: ${toolNames.join(', ')}`,
                recoveryKey: null,
            });
            if (overallStatus === HealthStatus.UNKNOWN) overallStatus = HealthStatus.HEALTHY;
        } catch {
            checks.push({
                name: 'Backend Tools',
                status: HealthStatus.OFFLINE,
                detail: 'Server not reachable — backend tools unavailable',
                recoveryKey: 'backend_tools_down',
            });
            if (overallStatus !== HealthStatus.OFFLINE) overallStatus = HealthStatus.DEGRADED;
            if (!lastError) lastError = 'Backend tools server not reachable';
        }

        // Backend health endpoint
        try {
            const res = await fetch('/api/health', { signal: AbortSignal.timeout(3000) });
            const data = await res.json().catch(() => null);
            if (data?.ok) {
                checks.push({
                    name: 'Server Health',
                    status: HealthStatus.HEALTHY,
                    detail: `Backend v${data.version || '?'} — uptime ${data.uptime || 'unknown'}`,
                    recoveryKey: null,
                });
            }
        } catch {
            // Non-critical — backend tools check covers this
        }

        // MCP server registry / discovery state
        try {
            const servers = mcpService.listServers();
            const enabled = servers.filter(server => server.enabled);
            if (servers.length === 0) {
                checks.push({
                    name: 'MCP Servers',
                    status: HealthStatus.UNKNOWN,
                    detail: 'No MCP servers configured',
                    recoveryKey: 'mcp_not_configured',
                });
            } else {
                const failed = enabled.filter(server => server.lastStatus === 'error');
                const toolCount = enabled.reduce((sum, server) => sum + (server.tools?.length || 0), 0);
                checks.push({
                    name: 'MCP Servers',
                    status: failed.length > 0 ? HealthStatus.DEGRADED : HealthStatus.HEALTHY,
                    detail: `${enabled.length}/${servers.length} enabled, ${toolCount} discovered tool(s)`,
                    recoveryKey: failed.length > 0 ? 'mcp_discovery_failed' : null,
                });
                if (failed.length > 0 && overallStatus !== HealthStatus.OFFLINE) {
                    overallStatus = HealthStatus.DEGRADED;
                    lastError = failed[0].lastError || 'MCP discovery failed';
                }
                if (overallStatus === HealthStatus.UNKNOWN) overallStatus = HealthStatus.HEALTHY;
            }
        } catch (e) {
            checks.push({ name: 'MCP Servers', status: HealthStatus.DEGRADED, detail: _sanitize(e.message), recoveryKey: 'mcp_discovery_failed' });
            if (overallStatus !== HealthStatus.OFFLINE) overallStatus = HealthStatus.DEGRADED;
            if (!lastError) lastError = _sanitize(e.message);
        }

        if (!anyConfigured) {
            checks.unshift({
                name: 'Web Search',
                status: HealthStatus.UNKNOWN,
                detail: 'No search provider configured',
                recoveryKey: 'search_no_provider',
            });
        }

        return { status: overallStatus, checks, lastError };
    }

    /** @private */
    async _checkTasks() {
        const checks = [];
        let overallStatus = HealthStatus.HEALTHY;
        let lastError = null;

        // Agent run persistence (just verify IndexedDB store is accessible)
        try {
            const { countRecords } = await import('./idbStore.js');
            const runCount = await countRecords('agentRuns');
            checks.push({
                name: 'Agent Run Store',
                status: HealthStatus.HEALTHY,
                detail: `${runCount} run(s) persisted`,
                recoveryKey: null,
            });
        } catch (e) {
            checks.push({ name: 'Agent Run Store', status: HealthStatus.DEGRADED, detail: _sanitize(e.message), recoveryKey: 'storage_error' });
            overallStatus = HealthStatus.DEGRADED;
            lastError = _sanitize(e.message);
        }

        // Tool registry
        try {
            const { toolRegistry } = await import('./toolRegistry.js');
            const tools = toolRegistry.list();
            checks.push({
                name: 'Tool Registry',
                status: HealthStatus.HEALTHY,
                detail: `${tools.length} tool(s) registered`,
                recoveryKey: null,
            });
        } catch (e) {
            checks.push({ name: 'Tool Registry', status: HealthStatus.DEGRADED, detail: _sanitize(e.message), recoveryKey: null });
            overallStatus = HealthStatus.DEGRADED;
            lastError = _sanitize(e.message);
        }

        return { status: overallStatus, checks, lastError };
    }

    // ─── Error capture ─────────────────────────────────────────────────────

    /** @private */
    _listenForErrors() {
        const errorEvents = [
            Events.STREAM_ERROR,
            Events.RAG_EMBEDDING_ERROR,
            Events.MCP_DISCOVERY_FAILED,
        ];
        for (const evt of errorEvents) {
            eventBus.on(evt, (data) => {
                this._logError('tasks', _sanitize(data?.error || data?.message || String(data)));
            });
        }

        // Capture unhandled errors
        window.addEventListener('error', (e) => {
            this._logError('browser', _sanitize(e.message));
        });

        window.addEventListener('synapse:quotaExceeded', () => {
            this._logError('storage', 'Storage quota exceeded');
        });

        window.addEventListener('synapse:migrationFailed', () => {
            this._logError('storage', 'IndexedDB migration failed');
        });
    }

    /** @private */
    _logError(domain, message) {
        this._errorLog.push({ ts: Date.now(), domain, message, level: 'error' });
        if (this._errorLog.length > MAX_LOG_ENTRIES) {
            this._errorLog = this._errorLog.slice(-MAX_LOG_ENTRIES);
        }
    }

    // ─── Internal helpers ──────────────────────────────────────────────────

    /** @private */
    _store(domain, settledResult) {
        const value = settledResult.status === 'fulfilled'
            ? settledResult.value
            : { status: HealthStatus.OFFLINE, checks: [], lastError: _sanitize(settledResult.reason?.message || 'Check failed') };

        this._results.set(domain, {
            ...value,
            lastCheck: Date.now(),
        });
    }

    /** @private */
    _overallStatus() {
        const priority = [HealthStatus.OFFLINE, HealthStatus.DEGRADED, HealthStatus.UNKNOWN, HealthStatus.HEALTHY];
        let worst = HealthStatus.HEALTHY;
        for (const [, r] of this._results) {
            if (priority.indexOf(r.status) < priority.indexOf(worst)) {
                worst = r.status;
            }
        }
        return worst;
    }
}

// ── Utility functions ─────────────────────────────────────────────────────

/**
 * Sanitize error messages to remove potential secrets (API keys, tokens).
 * @param {string} msg
 * @returns {string}
 */
function _sanitize(msg) {
    if (!msg) return 'Unknown error';
    return String(msg)
        .replace(/[?&](api_key|key|token|secret|password)=([^\s&]+)/gi, '$1=***')
        .replace(/(Bearer\s+)\S+/gi, '$1***')
        .replace(/sk-[a-zA-Z0-9]{20,}/g, 'sk-***');
}

/**
 * Format bytes into a human-readable string.
 * @param {number} bytes
 * @returns {string}
 */
function _fmtBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export const diagnosticsService = new DiagnosticsService();
