/**
 * ModelSelector - Dropdown component for selecting provider and model
 */

import { providerManager } from '../services/providerManager.js?v=27';
import { chatService } from '../services/chatService.js?v=27';
import { storageService } from '../services/storageService.js?v=27';
import { eventBus, Events } from '../utils/eventBus.js?v=27';

class ModelSelector {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.models = [];
        this.selectedModel = null;

        this.init();
    }

    async init() {
        this.render();
        await this.loadModels();
        this.attachEvents();
    }

    render() {
        const providers = providerManager.getAllProviders();
        const currentProvider = providerManager.getProviderName();

        this.container.innerHTML = `
            <div class="model-selector">
                <label for="provider-select">
                    <span class="label-icon">▸</span> PROVIDER
                </label>
                <select id="provider-select" class="terminal-select provider-select">
                    ${providers.map(p => `
                        <option value="${p.name}" ${p.name === currentProvider ? 'selected' : ''}>${p.label}</option>
                    `).join('')}
                </select>
                <label for="model-select" class="model-label">
                    MODEL
                </label>
                <select id="model-select" class="terminal-select">
                    <option value="">Loading models...</option>
                </select>
                <button id="refresh-models" class="icon-btn" title="Refresh models">
                    ↻
                </button>
            </div>
        `;
    }

    async loadModels() {
        const select = document.getElementById('model-select');

        try {
            const provider = providerManager.getProvider();
            this.models = await provider.listModels();

            if (this.models.length === 0) {
                select.innerHTML = '<option value="">No models found</option>';
                return;
            }

            // Load saved preference
            const settings = storageService.loadSettings();

            select.innerHTML = this.models.map(model => {
                const name = model.name;
                const size = model.size ? ` (${this.formatSize(model.size)})` : '';
                return `<option value="${name}" ${settings.selectedModel === name ? 'selected' : ''}>
                    ${name}${size}
                </option>`;
            }).join('');

            // Set selected model
            this.selectedModel = settings.selectedModel || this.models[0].name;
            if (!this.models.find(m => m.name === this.selectedModel)) {
                this.selectedModel = this.models[0].name;
            }
            select.value = this.selectedModel;

            eventBus.emit(Events.MODELS_LOADED, { models: this.models });
            eventBus.emit(Events.MODEL_CHANGED, { model: this.selectedModel });

        } catch (error) {
            console.error('Failed to load models:', error);
            const providerLabel = providerManager.getProviderLabel();
            select.innerHTML = `<option value="">⚠ ${providerLabel} not connected</option>`;
        }
    }

    formatSize(bytes) {
        if (!bytes) return 'N/A';
        const gb = bytes / (1024 * 1024 * 1024);
        return gb >= 1 ? `${gb.toFixed(1)}GB` : `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
    }

    attachEvents() {
        const providerSelect = document.getElementById('provider-select');
        const modelSelect = document.getElementById('model-select');
        const refreshBtn = document.getElementById('refresh-models');

        providerSelect.addEventListener('change', async (e) => {
            providerManager.setProvider(e.target.value);
            await this.loadModels();
        });

        modelSelect.addEventListener('change', (e) => {
            this.selectedModel = e.target.value;

            // Save preference
            const settings = storageService.loadSettings();
            settings.selectedModel = this.selectedModel;
            storageService.saveSettings(settings);

            // Update current chat model
            chatService.updateModel(this.selectedModel);

            eventBus.emit(Events.MODEL_CHANGED, { model: this.selectedModel });
        });

        refreshBtn.addEventListener('click', () => {
            this.loadModels();
            refreshBtn.classList.add('spinning');
            setTimeout(() => refreshBtn.classList.remove('spinning'), 500);
        });
    }

    getSelectedModel() {
        return this.selectedModel;
    }
}

export function createModelSelector(containerId) {
    return new ModelSelector(containerId);
}
