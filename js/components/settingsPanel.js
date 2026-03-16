/**
 * SettingsPanel - Modal component for application settings
 * Supports per-model parameter configuration with multi-provider support
 */

import { titleService } from '../services/titleService.js?v=34';
import { contextService } from '../services/contextService.js?v=34';
import { providerManager } from '../services/providerManager.js?v=34';
import { eventBus, Events } from '../utils/eventBus.js?v=34';
import { toast } from './toast.js?v=34';

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

class SettingsPanel {
    constructor() {
        this.isOpen = false;
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
                    <button id="settings-close-btn" class="settings-close-btn"><i data-lucide="x" class="icon"></i></button>
                </div>
                <div class="settings-content">
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
                        <h3>Title Generation</h3>
                        <p class="settings-description">Model used to auto-generate chat titles after the first exchange.</p>
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

                    <div class="settings-section">
                        <h3>Context Summarization</h3>
                        <p class="settings-description">Model used to summarize conversation history when the context window fills up. A small, fast model works well here.</p>
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
                <div class="settings-footer">
                    <button id="settings-save-btn" class="settings-btn primary">Save</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        if (typeof lucide !== 'undefined') lucide.createIcons();
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

    attachEventListeners() {
        document.getElementById('settings-close-btn').addEventListener('click', () => this.close());
        document.querySelector('.settings-overlay').addEventListener('click', () => this.close());
        document.getElementById('settings-save-btn').addEventListener('click', () => this.save());
        document.getElementById('reset-params-btn').addEventListener('click', () => this.resetParams());

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen) {
                this.close();
            }
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

        // Title provider change
        document.getElementById('title-provider-select').addEventListener('change', async (e) => {
            await this.loadModelsForProvider(e.target.value, 'title-model-select');
        });

        // Summarization provider change
        document.getElementById('summ-provider-select').addEventListener('change', async (e) => {
            await this.loadModelsForProvider(e.target.value, 'summ-model-select');
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
    }

    async open() {
        this.isOpen = true;
        document.getElementById('settings-modal').classList.remove('hidden');

        // Set param provider to current active provider
        const paramProviderSelect = document.getElementById('param-provider-select');
        paramProviderSelect.value = providerManager.getProviderName();
        this.updateTopKVisibility(paramProviderSelect.value);
        await this.loadModelsForProvider(paramProviderSelect.value, 'param-model-select');

        // Load title provider/model
        await this.loadTitleSettings();

        // Load summarization provider/model
        await this.loadSummarizationSettings();

        this.loadCurrentSettings();
    }

    close() {
        this.isOpen = false;
        document.getElementById('settings-modal').classList.add('hidden');
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

    loadCurrentSettings() {
        // Already handled in open()
    }

    getAllModelSettings() {
        const stored = localStorage.getItem('synapse_model_settings');
        return stored ? JSON.parse(stored) : {};
    }

    saveModelSettings(modelName, settings) {
        const allSettings = this.getAllModelSettings();
        allSettings[modelName] = settings;
        localStorage.setItem('synapse_model_settings', JSON.stringify(allSettings));
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
    const stored = localStorage.getItem('synapse_model_settings');
    const allSettings = stored ? JSON.parse(stored) : {};
    return allSettings[modelName] || { ...DEFAULT_PARAMS };
}
