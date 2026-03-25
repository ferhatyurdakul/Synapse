/**
 * ModelSelector - Dropdown component for selecting provider and model
 * Shows load state indicators for LM Studio models and triggers model loading
 */

import { providerManager } from '../services/providerManager.js?v=35';
import { chatService } from '../services/chatService.js?v=35';
import { storageService } from '../services/storageService.js?v=35';
import { eventBus, Events } from '../utils/eventBus.js?v=35';
import { toast } from './toast.js?v=35';
import { getModelParams } from './settingsPanel.js?v=35';

class ModelSelector {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.models = [];
        this.selectedModel = null;
        this.capabilityCache = {};
        this.isLoadingModel = false;

        this.init();
    }

    async init() {
        this.render();
        refreshIcons();
        await this.loadModels();
        this.attachEvents();
    }

    render() {
        const providers = providerManager.getAllProviders();
        const currentProvider = providerManager.getProviderName();

        this.container.innerHTML = `
            <div class="model-selector">
                <label for="provider-select">
                    <span class="label-icon"><i data-lucide="chevron-right" class="icon"></i></span> PROVIDER
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
                <button id="refresh-models" class="icon-btn" title="Refresh models" aria-label="Refresh models">
                    <i data-lucide="refresh-cw" class="icon"></i>
                </button>
                <span id="model-load-status" class="model-load-status"></span>
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
            const isLmStudio = providerManager.getProviderName() === 'lmstudio';

            select.innerHTML = this.models.map(model => {
                const name = model.name;
                const size = model.size ? ` (${this.formatSize(model.size)})` : '';
                const stateIndicator = this.getStateIndicator(model, isLmStudio);
                return `<option value="${name}" data-state="${model.state || ''}" ${settings.selectedModel === name ? 'selected' : ''}>${stateIndicator}${name}${size}</option>`;
            }).join('');

            // Set selected model
            this.selectedModel = settings.selectedModel || this.models[0].name;
            if (!this.models.find(m => m.name === this.selectedModel)) {
                this.selectedModel = this.models[0].name;
            }
            select.value = this.selectedModel;

            eventBus.emit(Events.MODELS_LOADED, { models: this.models });
            eventBus.emit(Events.MODEL_CHANGED, { model: this.selectedModel });
            this.checkModelCapabilities(this.selectedModel);

        } catch (error) {
            console.error('Failed to load models:', error);
            const providerLabel = providerManager.getProviderLabel();
            select.innerHTML = `<option value="">\u26A0 ${providerLabel} not connected</option>`;
        }
    }

    /**
     * Get state indicator prefix for a model option
     * @param {Object} model - Model object with state property
     * @param {boolean} isLmStudio - Whether current provider is LM Studio
     * @returns {string} Indicator prefix string
     */
    getStateIndicator(model, isLmStudio) {
        if (!isLmStudio || !model.state || model.state === 'unknown') return '';
        return model.state === 'loaded' ? '● ' : '○ ';
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
            this.capabilityCache = {};
            await this.loadModels();
        });

        modelSelect.addEventListener('change', async (e) => {
            this.selectedModel = e.target.value;

            // Save preference
            const settings = storageService.loadSettings();
            settings.selectedModel = this.selectedModel;
            storageService.saveSettings(settings);

            // Update current chat model
            chatService.updateModel(this.selectedModel);

            eventBus.emit(Events.MODEL_CHANGED, { model: this.selectedModel });
            this.checkModelCapabilities(this.selectedModel);

            // Auto-load unloaded LM Studio models
            await this.ensureModelLoaded(this.selectedModel);
        });

        refreshBtn.addEventListener('click', () => {
            this.loadModels();
            refreshBtn.classList.add('spinning');
            setTimeout(() => refreshBtn.classList.remove('spinning'), 500);
        });
    }

    /**
     * Ensure a model is loaded, triggering loading if needed (LM Studio only)
     * @param {string} modelName
     */
    async ensureModelLoaded(modelName) {
        if (this.isLoadingModel) return;

        const model = this.models.find(m => m.name === modelName);
        if (!model || model.state !== 'not-loaded') return;

        const provider = providerManager.getProvider();
        if (!provider.loadModel) return;

        this.isLoadingModel = true;
        const statusEl = document.getElementById('model-load-status');
        const refreshBtn = document.getElementById('refresh-models');

        try {
            if (statusEl) statusEl.textContent = 'Loading…';
            if (refreshBtn) refreshBtn.classList.add('spinning');
            eventBus.emit(Events.MODEL_LOADING, { model: modelName });

            const result = await provider.loadModel(modelName, getModelParams(modelName));

            // Update local model state
            model.state = 'loaded';
            this.updateOptionIndicator(modelName, 'loaded');

            if (statusEl) {
                statusEl.textContent = `Loaded (${(result.loadTime / 1000).toFixed(1)}s)`;
                setTimeout(() => { statusEl.textContent = ''; }, 3000);
            }

            eventBus.emit(Events.MODEL_LOADED, { model: modelName, loadTime: result.loadTime });
        } catch (error) {
            console.error('Failed to load model:', error);
            if (statusEl) {
                statusEl.textContent = 'Load failed';
                setTimeout(() => { statusEl.textContent = ''; }, 3000);
            }
            toast.error(`Failed to load model: ${error.message || 'Unknown error'}`);
        } finally {
            this.isLoadingModel = false;
            if (refreshBtn) refreshBtn.classList.remove('spinning');
        }
    }

    /**
     * Update the state indicator on a specific dropdown option
     * @param {string} modelName
     * @param {string} newState - 'loaded' or 'not-loaded'
     */
    updateOptionIndicator(modelName, newState) {
        const select = document.getElementById('model-select');
        if (!select) return;

        for (const option of select.options) {
            if (option.value === modelName) {
                option.dataset.state = newState;
                // Replace the indicator prefix (trim to handle any whitespace)
                const text = option.textContent.trim().replace(/^[●○]\s*/, '');
                const indicator = newState === 'loaded' ? '● ' : '○ ';
                option.textContent = indicator + text;
                break;
            }
        }
    }

    async checkModelCapabilities(model) {
        if (!model) return;

        const providerName = providerManager.getProviderName();
        const cacheKey = `${providerName}:${model}`;
        if (cacheKey in this.capabilityCache) {
            const cached = this.capabilityCache[cacheKey];
            eventBus.emit(Events.VISION_CAPABILITY_CHANGED, { supportsVision: cached.supportsVision, model });
            eventBus.emit(Events.TOOLS_CAPABILITY_CHANGED, { supportsTools: cached.supportsTools, model });
            return;
        }

        try {
            const provider = providerManager.getProvider();
            const info = await provider.getModelInfo(model);
            const supportsVision = info.supportsVision || false;
            const supportsTools = info.supportsTools !== undefined ? info.supportsTools : true;
            this.capabilityCache[cacheKey] = { supportsVision, supportsTools };
            eventBus.emit(Events.VISION_CAPABILITY_CHANGED, { supportsVision, model });
            eventBus.emit(Events.TOOLS_CAPABILITY_CHANGED, { supportsTools, model });
        } catch (e) {
            this.capabilityCache[cacheKey] = { supportsVision: false, supportsTools: true };
            eventBus.emit(Events.VISION_CAPABILITY_CHANGED, { supportsVision: false, model });
            eventBus.emit(Events.TOOLS_CAPABILITY_CHANGED, { supportsTools: true, model });
        }
    }

    getSelectedModel() {
        return this.selectedModel;
    }
}

export function createModelSelector(containerId) {
    return new ModelSelector(containerId);
}
