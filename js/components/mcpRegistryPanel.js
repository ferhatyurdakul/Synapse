/**
 * MCPRegistryPanel — Settings → Tools UI for MCP server registry.
 */
import { mcpService } from '../services/mcpService.js';
import { toast } from './toast.js';

let _instance = null;

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

export function createMCPRegistryPanel() {
    if (_instance) return _instance;
    _instance = new MCPRegistryPanel();
    return _instance;
}

class MCPRegistryPanel {
    constructor() {
        this.mount();
        mcpService.load().then(() => this.renderList()).catch(() => this.renderList());
    }

    mount() {
        const toolsPage = document.querySelector('.settings-page[data-page="tools"]');
        if (!toolsPage || document.getElementById('mcp-registry-section')) return;
        const section = document.createElement('div');
        section.className = 'settings-section mcp-registry-section';
        section.id = 'mcp-registry-section';
        section.innerHTML = `
            <div class="settings-section-header">
                <div>
                    <h3>MCP Servers</h3>
                    <p class="settings-description">Connect Synapse to Model Context Protocol servers. Server definitions are saved locally; auth tokens are one-time only and never exported with chats.</p>
                </div>
                <button class="settings-btn secondary" type="button" id="mcp-refresh-all-btn">Refresh Tools</button>
            </div>
            <div class="mcp-form-grid">
                <div class="settings-field">
                    <label for="mcp-name-input">Name</label>
                    <input id="mcp-name-input" class="settings-input" placeholder="Filesystem MCP">
                </div>
                <div class="settings-field">
                    <label for="mcp-transport-select">Transport</label>
                    <select id="mcp-transport-select" class="settings-select">
                        <option value="http">HTTP JSON-RPC</option>
                        <option value="stdio">Local stdio command</option>
                    </select>
                </div>
                <div class="settings-field mcp-http-field">
                    <label for="mcp-url-input">HTTP Endpoint</label>
                    <input id="mcp-url-input" class="settings-input" placeholder="http://localhost:3000/mcp">
                </div>
                <div class="settings-field mcp-stdio-field" style="display:none">
                    <label for="mcp-command-input">Command</label>
                    <input id="mcp-command-input" class="settings-input" placeholder="npx @modelcontextprotocol/server-filesystem .">
                </div>
                <div class="settings-field">
                    <label for="mcp-trust-select">Trust</label>
                    <select id="mcp-trust-select" class="settings-select">
                        <option value="untrusted">Untrusted — confirm every tool</option>
                        <option value="session">Trusted for session</option>
                        <option value="trusted">Trusted — confirm sensitive tools only</option>
                    </select>
                </div>
                <div class="settings-field">
                    <label for="mcp-token-input">Bearer token (optional, not saved)</label>
                    <input id="mcp-token-input" type="password" class="settings-input" placeholder="Only used for the next discovery request">
                </div>
            </div>
            <div class="mcp-actions">
                <button class="settings-btn primary" type="button" id="mcp-add-btn">Add Server</button>
            </div>
            <div id="mcp-server-list" class="mcp-server-list"></div>
        `;
        toolsPage.appendChild(section);
        this.bind(section);
        if (typeof lucide !== 'undefined') lucide.createIcons({ el: section });
    }

    bind(section) {
        section.querySelector('#mcp-transport-select')?.addEventListener('change', (event) => {
            const isStdio = event.target.value === 'stdio';
            section.querySelector('.mcp-http-field').style.display = isStdio ? 'none' : '';
            section.querySelector('.mcp-stdio-field').style.display = isStdio ? '' : 'none';
        });
        section.querySelector('#mcp-add-btn')?.addEventListener('click', () => this.addServer());
        section.querySelector('#mcp-refresh-all-btn')?.addEventListener('click', () => this.refreshAll());
        section.querySelector('#mcp-server-list')?.addEventListener('click', event => this.handleListClick(event));
    }

    async addServer() {
        const transport = document.getElementById('mcp-transport-select').value;
        const token = document.getElementById('mcp-token-input').value.trim();
        const server = await mcpService.saveServer({
            name: document.getElementById('mcp-name-input').value.trim() || 'MCP Server',
            transport,
            url: document.getElementById('mcp-url-input').value.trim(),
            command: document.getElementById('mcp-command-input').value.trim(),
            trustState: document.getElementById('mcp-trust-select').value,
            authConfigured: !!token
        });
        document.getElementById('mcp-token-input').value = '';
        await this.discover(server.id, token);
        toast.success(`Added ${server.name}`);
        this.renderList();
    }

    async refreshAll() {
        for (const server of mcpService.listServers().filter(entry => entry.enabled)) {
            await this.discover(server.id).catch(() => null);
        }
        this.renderList();
    }

    async discover(serverId, token = '') {
        try {
            await mcpService.discoverTools(serverId, token ? { token } : {});
        } catch (error) {
            toast.error(`MCP discovery failed: ${error.message}`);
        }
    }

    async handleListClick(event) {
        const button = event.target.closest('button[data-action]');
        if (!button) return;
        const { action, id } = button.dataset;
        if (action === 'discover') await this.discover(id);
        if (action === 'toggle') {
            const server = mcpService.getServer(id);
            await mcpService.setEnabled(id, !server.enabled);
        }
        if (action === 'delete' && confirm('Remove this MCP server?')) await mcpService.deleteServer(id);
        this.renderList();
    }

    renderList() {
        const list = document.getElementById('mcp-server-list');
        if (!list) return;
        const servers = mcpService.listServers();
        if (servers.length === 0) {
            list.innerHTML = '<p class="settings-hint">No MCP servers configured yet.</p>';
            return;
        }
        list.innerHTML = servers.map(server => `
            <article class="mcp-server-card ${server.enabled ? '' : 'mcp-disabled'}">
                <div class="mcp-server-header">
                    <div>
                        <strong>${esc(server.name)}</strong>
                        <span class="mcp-pill">${esc(server.transport)}</span>
                        <span class="mcp-pill mcp-status-${esc(server.lastStatus)}">${esc(server.lastStatus)}</span>
                    </div>
                    <div class="mcp-card-actions">
                        <button class="settings-btn secondary" data-action="toggle" data-id="${esc(server.id)}">${server.enabled ? 'Disable' : 'Enable'}</button>
                        <button class="settings-btn secondary" data-action="discover" data-id="${esc(server.id)}">Discover</button>
                        <button class="settings-btn secondary danger" data-action="delete" data-id="${esc(server.id)}">Remove</button>
                    </div>
                </div>
                <div class="mcp-server-meta">${esc(server.transport === 'stdio' ? server.command : server.url)} · ${esc(server.trustState)} · ${esc(server.scope)}</div>
                ${server.lastError ? `<div class="mcp-error">${esc(server.lastError)}</div>` : ''}
                <div class="mcp-tools">
                    ${(server.tools || []).map(tool => `
                        <span class="mcp-tool" title="${esc(tool.description)}">${esc(tool.name)}${tool.requiresConfirmation ? ' ⚠' : ''}</span>
                    `).join('') || '<span class="settings-hint">No tools discovered.</span>'}
                </div>
            </article>
        `).join('');
    }
}
