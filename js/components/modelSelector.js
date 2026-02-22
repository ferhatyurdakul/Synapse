/**
 * ModelSelector - Dropdown component for selecting Ollama models
 */

import { ollamaService } from '../services/ollamaService.js?v=24';
import { chatService } from '../services/chatService.js?v=24';
import { storageService } from '../services/storageService.js?v=24';
import { eventBus, Events } from '../utils/eventBus.js?v=24';

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
        this.container.innerHTML = `
            <div class="model-selector">
                <label for="model-select">
                    <span class="label-icon">▸</span> MODEL
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
            this.models = await ollamaService.listModels();

            if (this.models.length === 0) {
                select.innerHTML = '<option value="">No models found</option>';
                return;
            }

            // Load saved preference
            const settings = storageService.loadSettings();

            select.innerHTML = this.models.map(model => {
                const name = model.name;
                const size = this.formatSize(model.size);
                return `<option value="${name}" ${settings.selectedModel === name ? 'selected' : ''}>
                    ${name} (${size})
                </option>`;
            }).join('');

            // Set selected model
            this.selectedModel = settings.selectedModel || this.models[0].name;
            select.value = this.selectedModel;

            eventBus.emit(Events.MODELS_LOADED, { models: this.models });
            eventBus.emit(Events.MODEL_CHANGED, { model: this.selectedModel });

        } catch (error) {
            console.error('Failed to load models:', error);
            select.innerHTML = `<option value="">⚠ Ollama not connected</option>`;
        }
    }

    formatSize(bytes) {
        if (!bytes) return 'N/A';
        const gb = bytes / (1024 * 1024 * 1024);
        return gb >= 1 ? `${gb.toFixed(1)}GB` : `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
    }

    attachEvents() {
        const select = document.getElementById('model-select');
        const refreshBtn = document.getElementById('refresh-models');

        select.addEventListener('change', (e) => {
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
