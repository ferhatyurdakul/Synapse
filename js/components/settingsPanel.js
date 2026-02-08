/**
 * SettingsPanel - Modal component for application settings
 * Supports per-model parameter configuration
 */

import { titleService } from '../services/titleService.js?v=21';
import { ollamaService } from '../services/ollamaService.js?v=21';
import { eventBus, Events } from '../utils/eventBus.js?v=21';

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
        this.selectedModel = null;
        this.modelContextMax = 131072;
        this.render();
        this.attachEventListeners();
    }

    render() {
        const modal = document.createElement('div');
        modal.id = 'settings-modal';
        modal.className = 'settings-modal hidden';
        modal.innerHTML = `
            <div class="settings-overlay"></div>
            <div class="settings-panel">
                <div class="settings-header">
                    <h2>⚙️ Settings</h2>
                    <button id="settings-close-btn" class="settings-close-btn">×</button>
                </div>
                <div class="settings-content">
                    <div class="settings-section">
                        <h3>Model Parameters</h3>
                        <p class="settings-description">Configure parameters for each model. Settings are saved per-model.</p>
                        
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
                        <h3>Application Settings</h3>
                        <p class="settings-description">General application configuration.</p>
                        <div class="settings-field">
                            <label for="title-model-select">Title Generation Model</label>
                            <select id="title-model-select" class="settings-select">
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

        // Model selector change - load that model's settings
        document.getElementById('param-model-select').addEventListener('change', async (e) => {
            const model = e.target.value;
            if (model) {
                this.selectedModel = model;
                await this.loadModelSettings(model);
            }
        });

        // Slider value updates
        Object.keys(PARAM_DEFS).forEach(param => {
            const slider = document.getElementById(`${param}-slider`);
            const valueDisplay = document.getElementById(`${param}-value`);

            slider.addEventListener('input', (e) => {
                let value = parseFloat(e.target.value);
                // Format display based on parameter type
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
        await this.loadModels();
        this.loadCurrentSettings();
    }

    close() {
        this.isOpen = false;
        document.getElementById('settings-modal').classList.add('hidden');
    }

    async loadModels() {
        const paramSelect = document.getElementById('param-model-select');
        const titleSelect = document.getElementById('title-model-select');

        try {
            this.models = await ollamaService.listModels();

            const options = this.models.map(model =>
                `<option value="${model.name}">${model.name}</option>`
            ).join('');

            paramSelect.innerHTML = options || '<option value="">No models available</option>';
            titleSelect.innerHTML = options || '<option value="">No models available</option>';

            // Set default selected model for params
            if (this.models.length > 0) {
                this.selectedModel = this.models[0].name;
                await this.loadModelSettings(this.selectedModel);
            }
        } catch (error) {
            console.error('Failed to load models:', error);
            paramSelect.innerHTML = '<option value="">Failed to load models</option>';
            titleSelect.innerHTML = '<option value="">Failed to load models</option>';
        }
    }

    async loadModelSettings(modelName) {
        // Get model info to find max context length
        const modelInfo = await ollamaService.getModelInfo(modelName);
        this.modelContextMax = modelInfo.contextLength || 131072;

        // Update context length slider max
        const ctxSlider = document.getElementById('num_ctx-slider');
        ctxSlider.max = this.modelContextMax;

        // Load saved settings for this model
        const allSettings = this.getAllModelSettings();
        const modelSettings = allSettings[modelName] || { ...DEFAULT_PARAMS };

        // Ensure context doesn't exceed model max
        if (modelSettings.num_ctx > this.modelContextMax) {
            modelSettings.num_ctx = this.modelContextMax;
        }

        // Update all sliders
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
        // Load title model
        const titleSelect = document.getElementById('title-model-select');
        const currentTitleModel = titleService.getTitleModel();

        if (currentTitleModel && titleSelect.querySelector(`option[value="${currentTitleModel}"]`)) {
            titleSelect.value = currentTitleModel;
        } else if (this.models.length > 0) {
            titleSelect.value = this.models[0].name;
        }
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

            // Clamp context to model max
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
        // Save model parameters for selected model
        if (this.selectedModel) {
            const settings = {};
            Object.keys(PARAM_DEFS).forEach(param => {
                const slider = document.getElementById(`${param}-slider`);
                settings[param] = parseFloat(slider.value);
            });
            this.saveModelSettings(this.selectedModel, settings);
        }

        // Save title model
        const titleSelect = document.getElementById('title-model-select');
        const selectedTitleModel = titleSelect.value;
        if (selectedTitleModel) {
            titleService.setTitleModel(selectedTitleModel);
        }

        this.close();
        eventBus.emit(Events.SETTINGS_UPDATED, {
            titleModel: selectedTitleModel,
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
 * @returns {Object} Parameters object with temperature, top_p, top_k, repeat_penalty, num_ctx
 */
export function getModelParams(modelName) {
    const stored = localStorage.getItem('synapse_model_settings');
    const allSettings = stored ? JSON.parse(stored) : {};
    return allSettings[modelName] || { ...DEFAULT_PARAMS };
}
