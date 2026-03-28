/**
 * SettingsPanel - Tabbed modal component for application settings
 * Supports per-model parameter configuration with multi-provider support
 */

import { titleService } from '../services/titleService.js?v=36';
import { contextService } from '../services/contextService.js?v=36';
import { providerManager } from '../services/providerManager.js?v=36';
import { storageService } from '../services/storageService.js?v=36';
import { eventBus, Events } from '../utils/eventBus.js?v=36';
import { toast } from './toast.js?v=36';
import { themeService } from '../services/themeService.js?v=36';

// Default model parameters
const DEFAULT_PARAMS = {
    temperature: 0.7,
    top_p: 0.9,
    top_k: 40,
    repeat_penalty: 1.1,
    num_ctx: 4096
};

// Parameter definitions with ranges
const PARAM_DEFS = {
    temperature: { min: 0, max: 2, step: 0.1, label: 'Temperature', description: 'Controls randomness (higher = more creative)' },
    top_p: { min: 0, max: 1, step: 0.05, label: 'Top P', description: 'Nucleus sampling threshold' },
    top_k: { min: 1, max: 100, step: 1, label: 'Top K', description: 'Limits vocabulary to top K tokens' },
    repeat_penalty: { min: 0, max: 2, step: 0.1, label: 'Repeat Penalty', description: 'Penalizes repetitive text' },
    num_ctx: { min: 512, max: 131072, step: 512, label: 'Context Length', description: 'Token context window size' }
};

const TABS = [
    { id: 'general', label: 'General', icon: 'sliders-horizontal' },
    { id: 'models', label: 'Models', icon: 'brain' },
    { id: 'tools', label: 'Tools', icon: 'wrench' },
    { id: 'knowledge', label: 'Knowledge Base', icon: 'library' },
    { id: 'storage', label: 'Storage', icon: 'database' }
];

class SettingsPanel {
    constructor() {
        this.isOpen = false;
        this.activeTab = 'general';
        this.models = [];
        this.titleModels = [];
        this.summModels = [];
        this.selectedModel = null;
        this.modelContextMax = 131072;
        this.render();
        this.attachEventListeners();
    }

    render() {
        const providers = providerManager.getAllProviders();
        const providerOptions = providers.map(p =>
            `<option value="${p.name}">${p.label}</option>`
        ).join('');

        const modal = document.createElement('div');
        modal.id = 'settings-modal';
        modal.className = 'settings-modal hidden';
        modal.innerHTML = `
            <div class="settings-overlay"></div>
            <div class="settings-panel">
                <div class="settings-header">
                    <h2><i data-lucide="settings" class="icon"></i> Settings</h2>
                    <button id="settings-close-btn" class="settings-close-btn" title="Close" aria-label="Close"><i data-lucide="x" class="icon"></i></button>
                </div>
                <nav class="settings-tabs">
                    ${TABS.map(tab => `
                        <button class="settings-tab ${tab.id === 'general' ? 'active' : ''}" data-tab="${tab.id}">
                            <i data-lucide="${tab.icon}" class="icon"></i>
                            <span>${tab.label}</span>
                        </button>
                    `).join('')}
                </nav>
                <div class="settings-content">
                    <!-- General Tab -->
                    <div class="settings-page active" data-page="general">
                        <div class="settings-section">
                            <h3>Theme</h3>
                            <p class="settings-description">Choose the visual style for Synapse.</p>
                            <div class="settings-field">
                                <div class="theme-picker" id="theme-picker">
                                    <button class="theme-option" data-theme="retro" type="button">
                                        <div class="theme-preview retro-preview">
                                            <div class="theme-preview-sidebar"></div>
                                            <div class="theme-preview-main">
                                                <div class="theme-preview-msg"></div>
                                                <div class="theme-preview-msg"></div>
                                                <div class="theme-preview-input"></div>
                                            </div>
                                        </div>
                                        <span>Retro</span>
                                    </button>
                                    <button class="theme-option" data-theme="modern" type="button">
                                        <div class="theme-preview modern-preview">
                                            <div class="theme-preview-sidebar"></div>
                                            <div class="theme-preview-main">
                                                <div class="theme-preview-msg"></div>
                                                <div class="theme-preview-msg"></div>
                                                <div class="theme-preview-input"></div>
                                            </div>
                                        </div>
                                        <span>Modern</span>
                                    </button>
                                </div>
                            </div>
                        </div>

                        <div class="settings-section">
                            <h3>System Prompt</h3>
                            <p class="settings-description">Default instructions sent to the model at the start of every chat. Folder prompts override this.</p>
                            <div class="settings-field">
                                <textarea id="system-prompt-input" class="settings-textarea" rows="4"
                                    placeholder="e.g. You are a helpful coding assistant. Be concise and use examples."></textarea>
                            </div>
                        </div>

                        <div class="settings-section">
                            <h3>Provider URLs</h3>
                            <p class="settings-description">Base URLs for each provider. Change these if your LLM server runs on a different host or port.</p>
                            ${providers.map(p => `
                                <div class="settings-field">
                                    <label for="url-${p.name}">${p.label} URL</label>
                                    <div class="url-input-group">
                                        <input type="text" id="url-${p.name}" class="settings-input provider-url-input"
                                            placeholder="${providerManager.getDefaultUrl(p.name)}"
                                            value="${providerManager.getProviderUrl(p.name)}">
                                        <button class="url-test-btn" data-provider="${p.name}" title="Test connection" aria-label="Test connection">
                                            <i data-lucide="wifi" class="icon"></i>
                                        </button>
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    </div>

                    <!-- Models Tab -->
                    <div class="settings-page" data-page="models">
                        <div class="settings-section">
                            <h3>Model Parameters</h3>
                            <p class="settings-description">Configure parameters for each model. Settings are saved per-model.</p>

                            <div class="settings-field">
                                <label for="param-provider-select">Provider</label>
                                <select id="param-provider-select" class="settings-select">
                                    ${providerOptions}
                                </select>
                            </div>

                            <div class="settings-field">
                                <label for="param-model-select">Configure Model</label>
                                <select id="param-model-select" class="settings-select">
                                    <option value="">Loading models...</option>
                                </select>
                            </div>

                            <div class="settings-sliders" id="param-sliders">
                                ${this.renderSlider('temperature')}
                                ${this.renderSlider('top_p')}
                                ${this.renderSlider('top_k')}
                                ${this.renderSlider('repeat_penalty')}
                                ${this.renderSlider('num_ctx')}
                            </div>

                            <button id="reset-params-btn" class="settings-btn secondary">Reset to Defaults</button>
                        </div>

                        <div class="settings-section">
                            <div class="settings-section-header">
                                <div>
                                    <h3>Title Generation</h3>
                                    <p class="settings-description">Auto-generate chat titles after the first exchange.</p>
                                </div>
                                <label class="settings-toggle">
                                    <input type="checkbox" id="title-enabled-toggle">
                                    <span class="toggle-slider"></span>
                                </label>
                            </div>
                            <div id="title-settings-body" class="settings-toggle-body">
                                <div class="settings-field">
                                    <label for="title-provider-select">Provider</label>
                                    <select id="title-provider-select" class="settings-select">
                                        ${providerOptions}
                                    </select>
                                </div>
                                <div class="settings-field">
                                    <label for="title-model-select">Model</label>
                                    <select id="title-model-select" class="settings-select">
                                        <option value="">Loading models...</option>
                                    </select>
                                </div>
                            </div>
                        </div>

                        <div class="settings-section">
                            <div class="settings-section-header">
                                <div>
                                    <h3>Context Summarization</h3>
                                    <p class="settings-description">Summarize conversation history when the context window fills up.</p>
                                </div>
                                <label class="settings-toggle">
                                    <input type="checkbox" id="summ-enabled-toggle">
                                    <span class="toggle-slider"></span>
                                </label>
                            </div>
                            <div id="summ-settings-body" class="settings-toggle-body">
                                <div class="settings-field">
                                    <label for="summ-provider-select">Provider</label>
                                    <select id="summ-provider-select" class="settings-select">
                                        ${providerOptions}
                                    </select>
                                </div>
                                <div class="settings-field">
                                    <label for="summ-model-select">Model</label>
                                    <select id="summ-model-select" class="settings-select">
                                        <option value="">Loading models...</option>
                                    </select>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Tools Tab -->
                    <div class="settings-page" data-page="tools">
                        <div class="settings-section">
                            <div class="settings-section-header">
                                <div>
                                    <h3>Built-in Tools</h3>
                                    <p class="settings-description">Calculator, date/time, and unit converter. Models can call these during a conversation.</p>
                                </div>
                                <label class="settings-toggle">
                                    <input type="checkbox" id="tools-enabled-toggle" checked>
                                    <span class="toggle-slider"></span>
                                </label>
                            </div>
                        </div>

                        <div class="settings-section">
                            <h3>Web Search</h3>
                            <p class="settings-description">Enable web search as a tool. Toggled on/off per chat with the globe button.</p>
                            <div class="settings-field">
                                <label for="search-provider-select">Search Provider</label>
                                <select id="search-provider-select" class="settings-select">
                                    <option value="searxng">SearXNG (local)</option>
                                    <option value="brave">Brave Search (API key)</option>
                                </select>
                            </div>
                            <div id="searxng-settings">
                                <div class="settings-field">
                                    <label for="searxng-url-input">SearXNG URL</label>
                                    <div class="url-input-group">
                                        <input type="text" id="searxng-url-input" class="settings-input provider-url-input"
                                            placeholder="http://localhost:8888">
                                        <button class="url-test-btn" id="test-searxng-btn" title="Test SearXNG" aria-label="Test SearXNG">
                                            <i data-lucide="wifi" class="icon"></i>
                                        </button>
                                    </div>
                                    <p class="settings-hint">Run SearXNG locally: <code>docker run -p 8888:8080 searxng/searxng</code></p>
                                </div>
                            </div>
                            <div id="brave-settings" style="display:none">
                                <div class="settings-field">
                                    <label for="brave-api-key-input">Brave API Key</label>
                                    <div class="url-input-group">
                                        <input type="password" id="brave-api-key-input" class="settings-input provider-url-input"
                                            placeholder="BSA-...">
                                        <button class="url-test-btn" id="test-brave-btn" title="Test Brave Search" aria-label="Test Brave Search">
                                            <i data-lucide="wifi" class="icon"></i>
                                        </button>
                                    </div>
                                    <p class="settings-hint">Requires <code>python3 server.py</code> as the dev server (CORS proxy).</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Knowledge Base Tab -->
                    <div class="settings-page" data-page="knowledge">
                        <div class="settings-section">
                            <h3>Knowledge Base (RAG)</h3>
                            <p class="settings-description">Drop files into the chat input to add them to your knowledge base. The model can search your documents when answering questions.</p>
                        </div>

                        <div class="settings-section">
                            <h3>Embeddings</h3>
                            <p class="settings-description">Choose an embedding model for each provider. The active chat provider's model is used automatically.</p>
                            <div class="settings-field">
                                <label for="rag-model-ollama">Ollama</label>
                                <select id="rag-model-ollama" class="settings-select">
                                    <option value="">Loading models…</option>
                                </select>
                            </div>
                            <div class="settings-field">
                                <label for="rag-model-lmstudio">LM Studio</label>
                                <select id="rag-model-lmstudio" class="settings-select">
                                    <option value="">Loading models…</option>
                                </select>
                            </div>
                        </div>

                        <div class="settings-section">
                            <h3>Chunking</h3>
                            <div class="settings-field">
                                <label for="rag-chunk-size">Chunk size (characters)</label>
                                <input type="number" id="rag-chunk-size" class="settings-input" value="512" min="128" max="4096" step="64">
                            </div>
                            <div class="settings-field">
                                <label for="rag-chunk-overlap">Chunk overlap (characters)</label>
                                <input type="number" id="rag-chunk-overlap" class="settings-input" value="64" min="0" max="512" step="16">
                            </div>
                        </div>

                        <div class="settings-section">
                            <h3>Retrieval</h3>
                            <div class="settings-field">
                                <label for="rag-top-k">Results per search (Top K)</label>
                                <input type="number" id="rag-top-k" class="settings-input" value="5" min="1" max="20">
                            </div>
                            <div class="settings-field">
                                <label for="rag-threshold">Similarity threshold (0–1)</label>
                                <input type="number" id="rag-threshold" class="settings-input" value="0.3" min="0" max="1" step="0.05">
                            </div>
                        </div>

                    </div>

                    <!-- Storage Tab -->
                    <div class="settings-page" data-page="storage">
                        <div class="settings-section">
                            <h3>Storage Usage</h3>
                            <p class="settings-description">Data is stored in your browser's IndexedDB. No data leaves your machine.</p>
                            <div class="storage-stats" id="storage-stats">
                                <div class="storage-bar-container">
                                    <div class="storage-bar" id="storage-bar" style="width: 0%"></div>
                                </div>
                                <p class="storage-info" id="storage-info">Calculating...</p>
                                <div class="storage-counts" id="storage-counts"></div>
                            </div>
                        </div>

                        <div class="settings-section">
                            <h3>Cleanup</h3>
                            <p class="settings-description">Free up storage space by removing old chats.</p>
                            <div class="settings-field">
                                <label for="cleanup-days-input">Delete chats older than</label>
                                <div class="cleanup-row">
                                    <input type="number" id="cleanup-days-input" class="settings-input cleanup-input" value="90" min="1" max="3650">
                                    <span>days</span>
                                    <button class="settings-btn secondary cleanup-btn" id="cleanup-old-chats-btn">Delete</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="settings-footer">
                    <button id="settings-save-btn" class="settings-btn primary">Save</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        refreshIcons();
    }

    renderSlider(param) {
        const def = PARAM_DEFS[param];
        const value = DEFAULT_PARAMS[param];
        return `
            <div class="slider-field" data-param="${param}">
                <div class="slider-header">
                    <label>${def.label}</label>
                    <span class="slider-value" id="${param}-value">${value}</span>
                </div>
                <input type="range"
                    id="${param}-slider"
                    class="settings-slider"
                    min="${def.min}"
                    max="${def.max}"
                    step="${def.step}"
                    value="${value}">
                <p class="slider-description">${def.description}</p>
            </div>
        `;
    }

    switchTab(tabId) {
        this.activeTab = tabId;

        // Update tab buttons
        document.querySelectorAll('.settings-tab').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tabId);
        });

        // Update pages
        document.querySelectorAll('.settings-page').forEach(page => {
            page.classList.toggle('active', page.dataset.page === tabId);
        });

        if (tabId === 'storage') {
            this.refreshStorageStats();
        }
    }

    async refreshStorageStats() {
        const info = await storageService.getStorageInfo();

        const bar = document.getElementById('storage-bar');
        const infoEl = document.getElementById('storage-info');
        const countsEl = document.getElementById('storage-counts');

        if (!bar || !infoEl) return;

        const usedMB = (info.used / (1024 * 1024)).toFixed(1);
        const quotaMB = (info.quota / (1024 * 1024)).toFixed(0);
        const pct = info.quota > 0 ? Math.min(100, (info.used / info.quota) * 100) : 0;

        bar.style.width = pct.toFixed(1) + '%';
        bar.classList.toggle('warning', pct > 75);
        bar.classList.toggle('danger', pct > 90);

        infoEl.textContent = `${usedMB} MB used of ${quotaMB} MB available`;

        if (countsEl) {
            countsEl.innerHTML = `
                <span>${info.chatCount} chat${info.chatCount !== 1 ? 's' : ''}</span>
                <span>${info.messageCount} message${info.messageCount !== 1 ? 's' : ''}</span>
                <span>${info.attachmentCount} image${info.attachmentCount !== 1 ? 's' : ''}</span>
            `;
        }
    }

    _escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    attachEventListeners() {
        document.getElementById('settings-close-btn').addEventListener('click', () => this.close());
        document.querySelector('.settings-overlay').addEventListener('click', () => this.close());
        document.getElementById('settings-save-btn').addEventListener('click', () => this.save());
        document.getElementById('reset-params-btn').addEventListener('click', () => this.resetParams());

        // Theme picker — apply immediately on click
        document.querySelectorAll('.theme-option').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.theme-option').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                themeService.setTheme(btn.dataset.theme);
            });
        });

        // Tab switching
        document.querySelectorAll('.settings-tab').forEach(btn => {
            btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen) {
                this.close();
            }
        });

        // Test connection buttons
        document.querySelectorAll('.url-test-btn[data-provider]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const name = btn.dataset.provider;
                const input = document.getElementById(`url-${name}`);
                const url = input.value.trim() || providerManager.getDefaultUrl(name);

                btn.disabled = true;
                const icon = btn.querySelector('.icon');
                const origIcon = icon?.getAttribute('data-lucide');

                try {
                    const provider = providerManager.getProviderByName(name);
                    const savedUrl = provider.baseUrl;
                    provider.baseUrl = url.replace(/\/+$/, '');
                    const ok = await provider.isServerAvailable();
                    provider.baseUrl = savedUrl;

                    if (ok) {
                        toast.success(`${name === 'ollama' ? 'Ollama' : 'LM Studio'}: Connected`);
                        if (icon) { icon.setAttribute('data-lucide', 'check'); refreshIcons(); }
                    } else {
                        toast.error(`${name === 'ollama' ? 'Ollama' : 'LM Studio'}: Not reachable`);
                        if (icon) { icon.setAttribute('data-lucide', 'x'); refreshIcons(); }
                    }
                } catch {
                    toast.error(`${name === 'ollama' ? 'Ollama' : 'LM Studio'}: Connection failed`);
                    if (icon) { icon.setAttribute('data-lucide', 'x'); refreshIcons(); }
                }

                btn.disabled = false;
                setTimeout(() => {
                    if (icon) { icon.setAttribute('data-lucide', origIcon); refreshIcons(); }
                }, 2000);
            });
        });

        // Provider change for model params
        document.getElementById('param-provider-select').addEventListener('change', async (e) => {
            this.updateTopKVisibility(e.target.value);
            await this.loadModelsForProvider(e.target.value, 'param-model-select');
            const model = document.getElementById('param-model-select').value;
            if (model) {
                this.selectedModel = model;
                await this.loadModelSettings(model, e.target.value);
            }
        });

        // Model selector change - load that model's settings
        document.getElementById('param-model-select').addEventListener('change', async (e) => {
            const model = e.target.value;
            if (model) {
                this.selectedModel = model;
                const provider = document.getElementById('param-provider-select').value;
                await this.loadModelSettings(model, provider);
            }
        });

        // Title enabled toggle
        document.getElementById('title-enabled-toggle').addEventListener('change', (e) => {
            document.getElementById('title-settings-body').classList.toggle('collapsed', !e.target.checked);
        });

        // Summarization enabled toggle
        document.getElementById('summ-enabled-toggle').addEventListener('change', (e) => {
            document.getElementById('summ-settings-body').classList.toggle('collapsed', !e.target.checked);
        });

        // Title provider change
        document.getElementById('title-provider-select').addEventListener('change', async (e) => {
            await this.loadModelsForProvider(e.target.value, 'title-model-select');
        });

        // Summarization provider change
        document.getElementById('summ-provider-select').addEventListener('change', async (e) => {
            await this.loadModelsForProvider(e.target.value, 'summ-model-select');
        });

        // Search provider toggle
        document.getElementById('search-provider-select').addEventListener('change', (e) => {
            this.toggleSearchProviderUI(e.target.value);
        });

        // Test SearXNG connection
        document.getElementById('test-searxng-btn').addEventListener('click', async () => {
            const btn = document.getElementById('test-searxng-btn');
            const url = document.getElementById('searxng-url-input').value.trim() || 'http://localhost:8888';
            btn.disabled = true;
            try {
                const res = await fetch(`${url}/search?q=test&format=json&categories=general`);
                if (res.ok) {
                    toast.success('SearXNG: Connected');
                    this.flashTestIcon(btn, true);
                } else {
                    toast.error(`SearXNG: HTTP ${res.status}`);
                    this.flashTestIcon(btn, false);
                }
            } catch {
                toast.error('SearXNG: Connection failed');
                this.flashTestIcon(btn, false);
            }
            btn.disabled = false;
        });

        // Test Brave Search connection (via proxy)
        document.getElementById('test-brave-btn').addEventListener('click', async () => {
            const btn = document.getElementById('test-brave-btn');
            const apiKey = document.getElementById('brave-api-key-input').value.trim();
            if (!apiKey) {
                toast.error('Enter a Brave API key first');
                return;
            }
            btn.disabled = true;
            try {
                const res = await fetch(`/api/brave/res/v1/web/search?q=test&count=1`, {
                    headers: { 'X-Subscription-Token': apiKey, 'Accept': 'application/json' }
                });
                if (res.ok) {
                    toast.success('Brave Search: Connected');
                    this.flashTestIcon(btn, true);
                } else {
                    toast.error(`Brave Search: HTTP ${res.status}`);
                    this.flashTestIcon(btn, false);
                }
            } catch {
                toast.error('Brave Search: Connection failed. Is server.py running?');
                this.flashTestIcon(btn, false);
            }
            btn.disabled = false;
        });

        // Slider value updates
        Object.keys(PARAM_DEFS).forEach(param => {
            const slider = document.getElementById(`${param}-slider`);
            const valueDisplay = document.getElementById(`${param}-value`);

            slider.addEventListener('input', (e) => {
                let value = parseFloat(e.target.value);
                if (param === 'num_ctx' || param === 'top_k') {
                    valueDisplay.textContent = Math.round(value);
                } else {
                    valueDisplay.textContent = value.toFixed(param === 'top_p' ? 2 : 1);
                }
            });
        });


        // Storage tab — cleanup old chats
        document.getElementById('cleanup-old-chats-btn').addEventListener('click', async () => {
            const days = parseInt(document.getElementById('cleanup-days-input').value) || 90;
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - days);

            const { chatService } = await import('../services/chatService.js?v=36');
            const allChats = chatService.getAllChats();
            const oldChats = allChats.filter(c => new Date(c.updatedAt) < cutoff);

            if (oldChats.length === 0) {
                toast.info('No chats older than ' + days + ' days');
                return;
            }

            if (!confirm(`Delete ${oldChats.length} chat(s) older than ${days} days?`)) return;

            for (const chat of oldChats) {
                chatService.deleteChat(chat.id);
            }
            toast.success(`Deleted ${oldChats.length} old chat(s)`);
            this.refreshStorageStats();
        });

    }

    async open() {
        this.isOpen = true;
        document.getElementById('settings-modal').classList.remove('hidden');

        const settings = storageService.loadSettings();

        // Set active theme button
        const currentTheme = settings.theme || 'retro';
        document.querySelectorAll('.theme-option').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.theme === currentTheme);
        });

        // Load tools toggle
        document.getElementById('tools-enabled-toggle').checked = settings.toolsEnabled !== false;

        // Load RAG settings — load both providers in parallel
        await this.loadAllEmbeddingModels();
        document.getElementById('rag-chunk-size').value = settings.ragChunkSize || 512;
        document.getElementById('rag-chunk-overlap').value = settings.ragChunkOverlap || 64;
        document.getElementById('rag-top-k').value = settings.ragTopK || 5;
        document.getElementById('rag-threshold').value = settings.ragSimilarityThreshold ?? 0.3;

        // Load web search settings
        const searchProvider = settings.searchProvider || 'searxng';
        document.getElementById('search-provider-select').value = searchProvider;
        this.toggleSearchProviderUI(searchProvider);
        document.getElementById('searxng-url-input').value = settings.searxngUrl || '';
        document.getElementById('brave-api-key-input').value = settings.braveApiKey || '';

        // Load global system prompt
        const sysPromptInput = document.getElementById('system-prompt-input');
        if (sysPromptInput) sysPromptInput.value = settings.systemPrompt || '';

        // Load current provider URLs
        for (const p of providerManager.getAllProviders()) {
            const input = document.getElementById(`url-${p.name}`);
            if (input) input.value = providerManager.getProviderUrl(p.name);
        }

        // Set param provider to current active provider
        const paramProviderSelect = document.getElementById('param-provider-select');
        paramProviderSelect.value = providerManager.getProviderName();
        this.updateTopKVisibility(paramProviderSelect.value);
        await this.loadModelsForProvider(paramProviderSelect.value, 'param-model-select');

        // Load title toggle + provider/model
        const titleEnabled = settings.titleEnabled !== false;
        document.getElementById('title-enabled-toggle').checked = titleEnabled;
        document.getElementById('title-settings-body').classList.toggle('collapsed', !titleEnabled);
        await this.loadTitleSettings();

        // Load summarization toggle + provider/model
        const summEnabled = settings.summarizationEnabled !== false;
        document.getElementById('summ-enabled-toggle').checked = summEnabled;
        document.getElementById('summ-settings-body').classList.toggle('collapsed', !summEnabled);
        await this.loadSummarizationSettings();

    }

    close() {
        this.isOpen = false;
        document.getElementById('settings-modal').classList.add('hidden');
    }

    /**
     * Load embedding model selects for all providers in parallel.
     */
    async loadAllEmbeddingModels() {
        const settings = storageService.loadSettings();
        await Promise.all([
            this._loadEmbeddingSelect('ollama', 'rag-model-ollama', settings.ragEmbeddingsModelOllama),
            this._loadEmbeddingSelect('lmstudio', 'rag-model-lmstudio', settings.ragEmbeddingsModelLmstudio)
        ]);
    }

    /**
     * Populate a single embedding model select for a given provider.
     * @private
     */
    async _loadEmbeddingSelect(providerName, selectId, savedModel) {
        const select = document.getElementById(selectId);
        if (!select) return;

        select.innerHTML = '<option value="">Loading models…</option>';
        const baseUrl = providerManager.getProviderUrl(providerName);

        try {
            let models = [];

            if (providerName === 'ollama') {
                const res = await fetch(`${baseUrl}/api/tags`);
                if (!res.ok) throw new Error('Failed to fetch');
                const data = await res.json();
                const allModels = data.models || [];
                const embeddingKeywords = ['embed', 'bge', 'e5-', 'gte-', 'minilm', 'all-minilm'];
                models = allModels.map(m => ({
                    name: m.name,
                    isEmbedding: embeddingKeywords.some(kw => m.name.toLowerCase().includes(kw))
                }));
                models.sort((a, b) => (b.isEmbedding ? 1 : 0) - (a.isEmbedding ? 1 : 0));
            } else {
                // LM Studio: try v0 API for type-aware list
                let fetched = false;
                try {
                    const res = await fetch(`${baseUrl}/api/v0/models`);
                    if (res.ok) {
                        const data = await res.json();
                        const allModels = data.data || data || [];
                        models = allModels
                            .filter(m => m.type === 'embeddings')
                            .map(m => ({ name: m.id, isEmbedding: true }));
                        fetched = true;
                    }
                } catch { /* fall through */ }

                if (!fetched) {
                    const res = await fetch(`${baseUrl}/v1/models`);
                    if (res.ok) {
                        const data = await res.json();
                        models = (data.data || []).map(m => ({ name: m.id, isEmbedding: false }));
                    }
                }
            }

            if (models.length === 0) {
                select.innerHTML = '<option value="">No models found</option>';
                return;
            }

            select.innerHTML = models.map(m => {
                const prefix = m.isEmbedding ? '● ' : '';
                const sel = m.name === savedModel ? ' selected' : '';
                return `<option value="${m.name}"${sel}>${prefix}${m.name}</option>`;
            }).join('');

            // If saved model not in list, keep first option selected
        } catch (err) {
            console.error(`Failed to load embedding models for ${providerName}:`, err);
            select.innerHTML = '<option value="">Not connected</option>';
        }
    }

    toggleSearchProviderUI(provider) {
        document.getElementById('searxng-settings').style.display = provider === 'searxng' ? '' : 'none';
        document.getElementById('brave-settings').style.display = provider === 'brave' ? '' : 'none';
    }

    flashTestIcon(btn, success) {
        const icon = btn.querySelector('.icon');
        if (!icon) return;
        const orig = icon.getAttribute('data-lucide');
        icon.setAttribute('data-lucide', success ? 'check' : 'x');
        refreshIcons();
        setTimeout(() => {
            icon.setAttribute('data-lucide', orig);
            refreshIcons();
        }, 2000);
    }

    async loadModelsForProvider(providerName, selectId) {
        const select = document.getElementById(selectId);
        try {
            const provider = providerManager.getProviderByName(providerName);
            if (!provider) throw new Error('Unknown provider');

            const models = await provider.listModels();

            if (selectId === 'param-model-select') {
                this.models = models;
            } else if (selectId === 'title-model-select') {
                this.titleModels = models;
            } else {
                this.summModels = models;
            }

            const options = models.map(model =>
                `<option value="${model.name}">${model.name}</option>`
            ).join('');

            select.innerHTML = options || '<option value="">No models available</option>';

            // Set default model
            if (models.length > 0 && selectId === 'param-model-select') {
                this.selectedModel = models[0].name;
                await this.loadModelSettings(this.selectedModel, providerName);
            }
        } catch (error) {
            console.error(`Failed to load models for ${providerName}:`, error);
            select.innerHTML = '<option value="">Failed to load models</option>';
        }
    }

    async loadTitleSettings() {
        const titleProviderSelect = document.getElementById('title-provider-select');
        const titleProvider = titleService.getTitleProvider();
        titleProviderSelect.value = titleProvider;

        await this.loadModelsForProvider(titleProvider, 'title-model-select');

        const titleModelSelect = document.getElementById('title-model-select');
        const currentTitleModel = titleService.getTitleModel();
        if (currentTitleModel && titleModelSelect.querySelector(`option[value="${currentTitleModel}"]`)) {
            titleModelSelect.value = currentTitleModel;
        }
    }

    async loadSummarizationSettings() {
        const summProviderSelect = document.getElementById('summ-provider-select');
        const summProvider = contextService.getSummarizationProvider();
        summProviderSelect.value = summProvider;

        await this.loadModelsForProvider(summProvider, 'summ-model-select');

        const summModelSelect = document.getElementById('summ-model-select');
        const currentSummModel = contextService.getSummarizationModel();
        if (currentSummModel && summModelSelect.querySelector(`option[value="${currentSummModel}"]`)) {
            summModelSelect.value = currentSummModel;
        }
    }

    updateTopKVisibility(providerName) {
        const topKField = document.querySelector('.slider-field[data-param="top_k"]');
        if (topKField) topKField.style.display = providerName === 'lmstudio' ? 'none' : '';
    }

    async loadModelSettings(modelName, providerName) {
        try {
            const provider = providerManager.getProviderByName(providerName);
            if (!provider) return;

            const modelInfo = await provider.getModelInfo(modelName);
            this.modelContextMax = modelInfo.contextLength || 131072;
        } catch {
            this.modelContextMax = 131072;
        }

        const ctxSlider = document.getElementById('num_ctx-slider');
        ctxSlider.max = this.modelContextMax;

        const allSettings = this.getAllModelSettings();
        const modelSettings = allSettings[modelName] || { ...DEFAULT_PARAMS };

        if (modelSettings.num_ctx > this.modelContextMax) {
            modelSettings.num_ctx = this.modelContextMax;
        }

        Object.keys(PARAM_DEFS).forEach(param => {
            const slider = document.getElementById(`${param}-slider`);
            const valueDisplay = document.getElementById(`${param}-value`);
            const value = modelSettings[param] ?? DEFAULT_PARAMS[param];

            slider.value = value;
            if (param === 'num_ctx' || param === 'top_k') {
                valueDisplay.textContent = Math.round(value);
            } else {
                valueDisplay.textContent = parseFloat(value).toFixed(param === 'top_p' ? 2 : 1);
            }
        });
    }


    getAllModelSettings() {
        return storageService.loadModelSettings();
    }

    saveModelSettings(modelName, settings) {
        const allSettings = this.getAllModelSettings();
        allSettings[modelName] = settings;
        storageService.saveModelSettings(allSettings);
    }

    resetParams() {
        if (!this.selectedModel) return;

        Object.keys(PARAM_DEFS).forEach(param => {
            const slider = document.getElementById(`${param}-slider`);
            const valueDisplay = document.getElementById(`${param}-value`);
            let value = DEFAULT_PARAMS[param];

            if (param === 'num_ctx' && value > this.modelContextMax) {
                value = this.modelContextMax;
            }

            slider.value = value;
            if (param === 'num_ctx' || param === 'top_k') {
                valueDisplay.textContent = Math.round(value);
            } else {
                valueDisplay.textContent = parseFloat(value).toFixed(param === 'top_p' ? 2 : 1);
            }
        });
    }

    save() {
        // Save provider URLs
        const providers = providerManager.getAllProviders();
        for (const p of providers) {
            const input = document.getElementById(`url-${p.name}`);
            if (input) {
                const url = input.value.trim() || providerManager.getDefaultUrl(p.name);
                providerManager.setProviderUrl(p.name, url);
            }
        }

        // Save model parameters
        if (this.selectedModel) {
            const settings = {};
            Object.keys(PARAM_DEFS).forEach(param => {
                const slider = document.getElementById(`${param}-slider`);
                settings[param] = parseFloat(slider.value);
            });
            this.saveModelSettings(this.selectedModel, settings);
        }

        // Save title provider + model
        const titleProviderSelect = document.getElementById('title-provider-select');
        const titleSelect = document.getElementById('title-model-select');
        const selectedTitleProvider = titleProviderSelect.value;
        const selectedTitleModel = titleSelect.value;
        if (selectedTitleModel) {
            titleService.setTitleModel(selectedTitleModel);
            titleService.setTitleProvider(selectedTitleProvider);
        }

        // Save summarization provider + model
        const summProviderSelect = document.getElementById('summ-provider-select');
        const summSelect = document.getElementById('summ-model-select');
        const selectedSummProvider = summProviderSelect.value;
        const selectedSummModel = summSelect.value;
        if (selectedSummModel) {
            contextService.setSummarizationModel(selectedSummModel);
            contextService.setSummarizationProvider(selectedSummProvider);
        }

        // Save global system prompt + web search settings
        {
            const settings = storageService.loadSettings();
            const sysPromptInput = document.getElementById('system-prompt-input');
            if (sysPromptInput) settings.systemPrompt = sysPromptInput.value.trim();
            settings.toolsEnabled = document.getElementById('tools-enabled-toggle').checked;
            settings.titleEnabled = document.getElementById('title-enabled-toggle').checked;
            settings.summarizationEnabled = document.getElementById('summ-enabled-toggle').checked;
            settings.searchProvider = document.getElementById('search-provider-select').value;
            settings.searxngUrl = document.getElementById('searxng-url-input').value.trim();
            settings.braveApiKey = document.getElementById('brave-api-key-input').value.trim();

            // RAG settings — per-provider embedding models
            settings.ragEmbeddingsModelOllama = document.getElementById('rag-model-ollama').value || '';
            settings.ragEmbeddingsModelLmstudio = document.getElementById('rag-model-lmstudio').value || '';
            settings.ragChunkSize = parseInt(document.getElementById('rag-chunk-size').value) || 512;
            settings.ragChunkOverlap = parseInt(document.getElementById('rag-chunk-overlap').value) || 64;
            settings.ragTopK = parseInt(document.getElementById('rag-top-k').value) || 5;
            settings.ragSimilarityThreshold = parseFloat(document.getElementById('rag-threshold').value) || 0.3;

            storageService.saveSettings(settings);
        }

        toast.success('Settings saved');
        this.close();
        eventBus.emit(Events.SETTINGS_UPDATED, {
            titleProvider: selectedTitleProvider,
            titleModel: selectedTitleModel,
            summarizationProvider: selectedSummProvider,
            summarizationModel: selectedSummModel,
            modelSettings: this.getAllModelSettings()
        });
    }
}

// Export singleton and factory
let settingsPanelInstance = null;

export function createSettingsPanel() {
    if (!settingsPanelInstance) {
        settingsPanelInstance = new SettingsPanel();
    }
    return settingsPanelInstance;
}

export function openSettings() {
    if (!settingsPanelInstance) {
        settingsPanelInstance = new SettingsPanel();
    }
    settingsPanelInstance.open();
}

/**
 * Get model parameters for a specific model
 * @param {string} modelName - Model name
 * @returns {Object} Parameters object
 */
export function getModelParams(modelName) {
    const allSettings = storageService.loadModelSettings();
    return allSettings[modelName] || { ...DEFAULT_PARAMS };
}
