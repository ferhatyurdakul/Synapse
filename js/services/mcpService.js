/**
 * MCPService — persisted MCP server registry + discovery/client bridge.
 *
 * This browser service stores non-secret server metadata in IndexedDB and asks
 * the Synapse Python dev server to perform MCP discovery/calls. Secrets are
 * accepted only as transient form input and are intentionally not persisted.
 */
import { putRecord, getAllRecords, getRecord, deleteRecord } from './idbStore.js';
import { toolRegistry } from './toolRegistry.js';
import { eventBus, Events } from '../utils/eventBus.js';

const STORE = 'mcpServers';
const SECRET_KEYS = new Set(['authorization', 'api-key', 'x-api-key', 'token', 'secret', 'password']);
const ALLOWED_TRANSPORTS = new Set(['http', 'stdio']);
const ALLOWED_TRUST = new Set(['untrusted', 'trusted', 'session']);

function id() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function now() {
    return new Date().toISOString();
}

function clone(value) {
    return JSON.parse(JSON.stringify(value ?? null));
}

function stripSecrets(headers = {}) {
    const safe = {};
    for (const [key, value] of Object.entries(headers || {})) {
        if (SECRET_KEYS.has(String(key).toLowerCase())) continue;
        safe[key] = value;
    }
    return safe;
}

function toToolRegistryName(server, tool) {
    const safeServer = String(server.name || server.id || 'server')
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 28) || 'server';
    const safeTool = String(tool.name || 'tool')
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 32) || 'tool';
    return `mcp_${safeServer}_${safeTool}`.slice(0, 64);
}

function normalizeServer(input = {}) {
    const timestamp = now();
    const transport = ALLOWED_TRANSPORTS.has(input.transport) ? input.transport : 'http';
    const trustState = ALLOWED_TRUST.has(input.trustState) ? input.trustState : 'untrusted';
    return {
        id: input.id || id(),
        name: String(input.name || 'MCP Server').trim() || 'MCP Server',
        transport,
        url: transport === 'http' ? String(input.url || '').trim() : '',
        command: transport === 'stdio' ? String(input.command || '').trim() : '',
        args: transport === 'stdio' ? String(input.args || '').split(/\s+/).filter(Boolean) : [],
        enabled: input.enabled !== false,
        trustState,
        scope: input.scope === 'global' ? 'global' : 'session',
        authConfigured: !!input.authConfigured,
        headers: stripSecrets(input.headers),
        tools: Array.isArray(input.tools) ? input.tools : [],
        lastStatus: input.lastStatus || 'unknown',
        lastError: input.lastError || null,
        lastDiscoveredAt: input.lastDiscoveredAt || null,
        createdAt: input.createdAt || timestamp,
        updatedAt: timestamp
    };
}

function toolNeedsConfirmation(server, tool) {
    if (server.trustState !== 'trusted') return true;
    const text = `${tool.name || ''} ${tool.description || ''}`.toLowerCase();
    return /write|delete|remove|shell|command|exec|file|secret|token|credential/.test(text);
}

function formatToolResult(value) {
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

class MCPService {
    constructor() {
        this.servers = [];
    }

    async load() {
        this.servers = (await getAllRecords(STORE)).map(normalizeServer)
            .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
        this.registerDiscoveredTools();
        return this.listServers();
    }

    listServers() {
        return clone(this.servers);
    }

    getServer(serverId) {
        return clone(this.servers.find(server => server.id === serverId) || null);
    }

    async saveServer(input) {
        const existing = input.id ? await getRecord(STORE, input.id) : null;
        const server = normalizeServer({ ...existing, ...input, createdAt: existing?.createdAt });
        await putRecord(STORE, server);
        await this.load();
        eventBus.emit(Events.MCP_SERVERS_CHANGED, { servers: this.listServers() });
        return clone(server);
    }

    async deleteServer(serverId) {
        await deleteRecord(STORE, serverId);
        await this.load();
        eventBus.emit(Events.MCP_SERVERS_CHANGED, { servers: this.listServers() });
    }

    async setEnabled(serverId, enabled) {
        const server = this.servers.find(entry => entry.id === serverId);
        if (!server) throw new Error('MCP server not found');
        return this.saveServer({ ...server, enabled });
    }

    async discoverTools(serverId, transient = {}) {
        const server = this.servers.find(entry => entry.id === serverId);
        if (!server) throw new Error('MCP server not found');
        const payload = {
            server: {
                ...server,
                headers: { ...(server.headers || {}), ...(transient.headers || {}) },
                token: transient.token || null
            }
        };
        eventBus.emit(Events.MCP_DISCOVERY_STARTED, { serverId });
        try {
            const response = await fetch('/api/mcp/discover', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await response.json().catch(() => null);
            if (!response.ok || data?.ok === false) {
                throw new Error(data?.error || `MCP discovery failed (${response.status})`);
            }
            const tools = (data.tools || []).map(tool => ({
                name: tool.name,
                description: tool.description || '',
                inputSchema: tool.inputSchema || tool.parameters || {},
                requiresConfirmation: toolNeedsConfirmation(server, tool)
            }));
            const updated = await this.saveServer({
                ...server,
                tools,
                lastStatus: 'connected',
                lastError: null,
                authConfigured: server.authConfigured || !!transient.token,
                lastDiscoveredAt: now()
            });
            eventBus.emit(Events.MCP_DISCOVERY_FINISHED, { serverId, tools });
            this.registerDiscoveredTools();
            return updated;
        } catch (error) {
            const updated = await this.saveServer({
                ...server,
                lastStatus: 'error',
                lastError: error.message || String(error)
            });
            eventBus.emit(Events.MCP_DISCOVERY_FAILED, { serverId, error: updated.lastError });
            throw error;
        }
    }

    getToolMetadata() {
        return this.servers
            .filter(server => server.enabled)
            .flatMap(server => (server.tools || []).map(tool => ({
                serverId: server.id,
                serverName: server.name,
                trustState: server.trustState,
                scope: server.scope,
                registryName: toToolRegistryName(server, tool),
                ...tool
            })));
    }

    registerDiscoveredTools() {
        toolRegistry.unregisterWhere(tool => tool.category === 'mcp');
        for (const server of this.servers.filter(entry => entry.enabled)) {
            for (const tool of server.tools || []) {
                const registryName = toToolRegistryName(server, tool);
                toolRegistry.register({
                    name: registryName,
                    description: `[MCP: ${server.name}] ${tool.description || tool.name || 'MCP tool'}`,
                    category: 'mcp',
                    parameters: tool.inputSchema || { type: 'object', properties: {} },
                    mcp: {
                        serverId: server.id,
                        serverName: server.name,
                        toolName: tool.name,
                        requiresConfirmation: tool.requiresConfirmation !== false,
                        trustState: server.trustState
                    },
                    handler: async (args = {}) => this.callTool(server.id, tool.name, args, { registryName })
                });
            }
        }
    }

    async callTool(serverId, toolName, args = {}, options = {}) {
        const server = this.servers.find(entry => entry.id === serverId);
        if (!server) throw new Error('MCP server not found');
        if (!server.enabled) throw new Error(`MCP server "${server.name}" is disabled`);

        const metadata = {
            serverId: server.id,
            serverName: server.name,
            toolName,
            registryName: options.registryName || toolName,
            trustState: server.trustState,
            startedAt: now()
        };
        eventBus.emit(Events.MCP_TOOL_CALL_STARTED, { ...metadata, input: args });

        try {
            const response = await fetch('/api/mcp/call', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ server, tool: toolName, args })
            });
            const data = await response.json().catch(() => null);
            if (!response.ok || data?.ok === false) {
                throw new Error(data?.error || `MCP tool call failed (${response.status})`);
            }
            const result = formatToolResult(data.result ?? data);
            eventBus.emit(Events.MCP_TOOL_CALL_COMPLETED, {
                ...metadata,
                input: args,
                output: data.result ?? data,
                status: 'completed',
                finishedAt: now()
            });
            return result;
        } catch (error) {
            eventBus.emit(Events.MCP_TOOL_CALL_COMPLETED, {
                ...metadata,
                input: args,
                error: error.message || String(error),
                status: 'failed',
                finishedAt: now()
            });
            throw error;
        }
    }
}

export const mcpService = new MCPService();
